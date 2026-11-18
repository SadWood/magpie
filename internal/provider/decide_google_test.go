package provider

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
)

func TestGoogleDecisionPreset(t *testing.T) {
	arkHome(t)
	p, err := FromPreset("google")
	if err != nil {
		t.Fatal(err)
	}
	p.Key = "test-google-key"
	if !p.Decides() || p.DecideVia() != ViaGoogle || p.Jev() != GoogleDecision || !p.AsksDecideModels() {
		t.Fatalf("decision provider: %+v", p)
	}
	if !p.DecidesModel(GoogleDecision) || !p.DecidesModel("models/"+GoogleDecision) || p.DecidesModel("gemini-3-flash") {
		t.Fatal("incorrect model classification")
	}
	if ms := p.DecisionModels(); len(ms) != 1 || ms[0].ID != GoogleDecision {
		t.Fatalf("models: %+v", ms)
	}
	if m, ok := resolveDecideModel(p, "models/"+GoogleDecision); !ok || m != GoogleDecision {
		t.Fatalf("alias: %s %v", m, ok)
	}
	u, err := p.DecideURL(context.Background())
	if err != nil || u != "https://generativelanguage.googleapis.com/v1beta/decisions" {
		t.Fatalf("URL %s: %v", u, err)
	}
	req, _ := http.NewRequest("POST", u, nil)
	if err := p.Sign(context.Background(), req, p.DecideProtocol(), nil); err != nil {
		t.Fatal(err)
	}
	if req.Header.Get("x-goog-api-key") != p.Key || req.Header.Get("Authorization") != "" {
		t.Fatalf("wrong auth: %v", req.Header)
	}
	p.Decide = ""
	if p = normalize(p); p.Decide == "" {
		t.Fatal("saved Google preset did not acquire decisions")
	}
	for _, base := range []string{"https://relay.example/v1beta/openai", "http://generativelanguage.googleapis.com/v1beta/openai", "https://generativelanguage.googleapis.com.evil.test/v1beta/openai"} {
		if got := (Provider{Chat: base}).googleDecisionBase(); got != "" {
			t.Fatalf("guessed endpoint %s", got)
		}
	}
}

func TestGoogleDecisionWire(t *testing.T) {
	body := []byte(`{"state":{"message":"现在改代码","previous_user_message":"前一轮"},"questions":{"intent":{"type":"choice","instructions":"选择","criteria":{"z_code":null,"a_write":"写作"}},"score":{"type":"score","instructions":"难度","criteria":["简单","复杂"]}}}`)
	b, err := PrepareDecideAsk(ViaGoogle, "models/"+GoogleDecision, body)
	if err != nil {
		t.Fatal(err)
	}
	var q map[string]any
	json.Unmarshal(b, &q)
	if q["model"] != GoogleDecision || q["state"] != nil || !strings.Contains(q["input"].(string), "previous_user_message") {
		t.Fatalf("request: %s", b)
	}
	if !strings.Contains(string(b), `"z_code":""`) {
		t.Fatalf("null description: %s", b)
	}
	// Reordering JSON never renames business IDs or changes their meaning.
	reversed := strings.Replace(string(body), `"z_code":null,"a_write":"写作"`, `"a_write":"写作","z_code":null`, 1)
	rev, err := PrepareDecideAsk(ViaGoogle, GoogleDecision, []byte(reversed))
	if err != nil || string(rev) != string(b) {
		t.Fatalf("reordered: %s %v", rev, err)
	}
	reply := []byte(`{"answers":{"intent":{"type":"choice","choice":"a_write","probabilities":{"z_code":0.5,"a_write":0.5},"confidence":0.5}},"usage":{"total_input_tokens":162,"total_output_tokens":0}}`)
	var out map[string]any
	json.Unmarshal(DecideAnswer(ViaGoogle, reply), &out)
	answer := out["answers"].(map[string]any)["intent"].(map[string]any)
	if answer["choice"] != "a_write" || answer["confidence"] != 0.5 || out["usage"].(map[string]any)["input_tokens"] != float64(162) {
		t.Fatalf("reply: %+v", out)
	}
	for _, bad := range []string{
		`{"state":"x","images":["x"],"questions":{"ok":{"type":"noul"}}}`,
		`{"state":"x","questions":{"ok":{"type":"score","criteria":["", "high"]}}}`,
		`{"state":"x","questions":{"ok":{"type":"choice","criteria":{"one":""}}}}`,
		`{"state":"x","questions":{"中文":{"type":"noul"}}}`,
	} {
		if _, err := PrepareDecideAsk(ViaGoogle, GoogleDecision, []byte(bad)); err == nil {
			t.Fatalf("accepted %s", bad)
		}
	}
	if b := DecideAnswer(ViaGoogle, []byte(`{"error":{"message":"bad key"}}`)); string(b) != `{"error":{"message":"bad key"}}` {
		t.Fatalf("changed error: %s", b)
	}
}

func TestGoogleDecisionProbe(t *testing.T) {
	arkHome(t)
	p, err := FromPreset("google")
	if err != nil {
		t.Fatal(err)
	}
	p.Key = "probe-google-key"
	var mu sync.Mutex
	calls := 0
	old := http.DefaultClient.Transport
	http.DefaultClient.Transport = openCodeTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.String() != "https://generativelanguage.googleapis.com/v1beta/decisions" {
			return nil, fmt.Errorf("unexpected network request: %s", r.URL)
		}
		mu.Lock()
		calls++
		mu.Unlock()
		b, _ := io.ReadAll(r.Body)
		if r.Header.Get("x-goog-api-key") != p.Key || r.Header.Get("Authorization") != "" || !strings.Contains(string(b), `"input":`) || strings.Contains(string(b), `"state":`) {
			t.Errorf("probe: %v %s", r.Header, b)
		}
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"answers":{"ok":{"type":"noul","noul":0.99,"confidence":0.99}},"usage":{"total_input_tokens":100,"total_output_tokens":0}}`)), Request: r}, nil
	})
	t.Cleanup(func() { http.DefaultClient.Transport = old })
	if err := p.AskSystemOne(context.Background(), GoogleDecision); err != nil {
		t.Fatal(err)
	}
	if ms, err := p.fetchDecide(context.Background()); err != nil || len(ms) != 1 || ms[0].ID != GoogleDecision {
		t.Fatalf("discover: %+v %v", ms, err)
	}
	mu.Lock()
	n := calls
	mu.Unlock()
	if n != 2 {
		t.Fatalf("calls: %d", n)
	}
}

func TestGoogleDecisionLimits(t *testing.T) {
	for _, n := range []int{1, 2, 255, 256} {
		for _, kind := range []string{"choice", "score"} {
			var criteria any
			if kind == "choice" {
				options := map[string]string{}
				for i := range n {
					options[fmt.Sprintf("option_%d", i)] = ""
				}
				criteria = options
			} else {
				levels := make([]string, n)
				for i := range levels {
					levels[i] = fmt.Sprintf("Level %d", i)
				}
				criteria = levels
			}
			b, _ := json.Marshal(map[string]any{"state": "text", "questions": map[string]any{"q": map[string]any{"type": kind, "instructions": "Choose", "criteria": criteria}}})
			_, err := PrepareDecideAsk(ViaGoogle, GoogleDecision, b)
			if (err == nil) != (n >= 2 && n <= 255) {
				t.Fatalf("%s %d: %v", kind, n, err)
			}
		}
	}
	for _, n := range []int{0, 1, 1000, 1001} {
		qs := map[string]any{}
		for i := range n {
			qs[fmt.Sprintf("q%d", i)] = map[string]string{"type": "noul", "instructions": "Is this text?"}
		}
		b, _ := json.Marshal(map[string]any{"state": "text", "questions": qs})
		_, err := PrepareDecideAsk(ViaGoogle, GoogleDecision, b)
		if (err == nil) != (n >= 1 && n <= 1000) {
			t.Fatalf("questions %d: %v", n, err)
		}
	}
	for _, value := range []string{`1`, `{}`, `[]`, `true`} {
		b := []byte(`{"state":"text","questions":{"q":{"type":"choice","instructions":"Choose","criteria":{"a":` + value + `,"b":""}}}}`)
		if _, err := PrepareDecideAsk(ViaGoogle, GoogleDecision, b); err == nil {
			t.Fatalf("accepted description %s", value)
		}
	}
	for _, n := range []int{0, 1, 64, 65} {
		if googleQuestionKey(strings.Repeat("a", n)) != (n >= 1 && n <= 64) {
			t.Fatalf("question key length %d", n)
		}
	}
}
