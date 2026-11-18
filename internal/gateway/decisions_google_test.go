package gateway

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/yetone/magpie/internal/provider"
)

// Google's native answer shape, as documented in its Decisions API guide:
// https://aistudio.google.com/docs/decisions-api (2026-11-18).
const googleDecisionReply = `{"answers":{"damaged":{"type":"noul","noul":0.91,"confidence":0.91},"condition":{"type":"choice","choice":"used","probabilities":{"new":0.12,"used":0.88},"confidence":0.88},"severity":{"type":"score","score":2.05,"probabilities":{"0":0.01,"1":0.09,"2":0.73,"3":0.17},"confidence":0.73}},"usage":{"total_input_tokens":452,"total_output_tokens":0}}`

func TestGoogleDecisionGateway(t *testing.T) {
	fresh(t)
	p, err := provider.FromPreset("google")
	if err != nil {
		t.Fatal(err)
	}
	p.Key = "test-google-key"
	if _, err := provider.Add(p); err != nil {
		t.Fatal(err)
	}
	s := New()
	s.client = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.Method != "POST" || r.URL.String() != "https://generativelanguage.googleapis.com/v1beta/decisions" || r.Header.Get("x-goog-api-key") != p.Key || r.Header.Get("Authorization") != "" {
			t.Errorf("request: %s %s %v", r.Method, r.URL, r.Header)
		}
		b, _ := io.ReadAll(r.Body)
		var q map[string]any
		json.Unmarshal(b, &q)
		if q["model"] != provider.GoogleDecision || q["input"] == nil || q["state"] != nil {
			t.Errorf("body: %s", b)
		}
		if strings.Contains(string(b), `"new":null`) {
			t.Errorf("Google received null criterion: %s", b)
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(googleDecisionReply)), Request: r}, nil
	})}
	ask := strings.ReplaceAll(parcelDecision, "qwen-decision/decision-model-preview", "google/models/"+provider.GoogleDecision)
	code, out := sendTo(s, "/v1/decisions", ask)
	if code != 200 {
		t.Fatalf("Decisions: %d %s", code, out)
	}
	var d struct {
		Answers []map[string]any `json:"answers"`
		Usage   map[string]any   `json:"usage"`
	}
	if err := json.Unmarshal([]byte(out), &d); err != nil || len(d.Answers) != 3 || d.Answers[0]["name"] != "damaged" || d.Answers[1]["choice"] != "used" || d.Usage["input_tokens"] != float64(452) {
		t.Fatalf("Decision answer: %s", out)
	}
	code, out = sendTo(s, "/v1/systemone", `{"model":"google/gemini-decision-1","state":"The parcel arrived torn open","questions":{"damaged":{"type":"noul","instructions":"Damaged?"}}}`)
	if code != 200 || !strings.Contains(out, `"input_tokens":452`) {
		t.Fatalf("System One: %d %s", code, out)
	}
	code, out = sendTo(s, "/v1/systemone", `{"model":"google/gemini-decision-1","state":"x","images":["https://example.test/x.png"],"questions":{"ok":{"type":"noul","instructions":"ok?"}}}`)
	if code != 400 || !strings.Contains(out, "images") {
		t.Fatalf("media: %d %s", code, out)
	}
}

func TestGoogleDecisionClassifier(t *testing.T) {
	fresh(t)
	p, err := provider.FromPreset("google")
	if err != nil {
		t.Fatal(err)
	}
	p.Key = "test-key"
	s := New()
	s.client = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		b, _ := io.ReadAll(r.Body)
		var q struct {
			Model     string
			Input     string
			Questions map[string]json.RawMessage
		}
		json.Unmarshal(b, &q)
		if q.Model != provider.GoogleDecision || !strings.Contains(q.Input, "previous_assistant_reply") || !strings.Contains(q.Input, "previous_user_message") || !strings.Contains(q.Input, "previous_message_reasoning") {
			t.Errorf("classifier lost context: %s", b)
		}
		if !strings.Contains(string(q.Questions["intent"]), `"代码":""`) {
			t.Errorf("intent IDs changed: %s", b)
		}
		reply := `{"answers":{"intent":{"type":"choice","choice":"代码","confidence":0.9,"probabilities":{"代码":0.9,"none":0.1}},"effort":{"type":"score","score":2,"confidence":0.8,"probabilities":{"0":0.1,"1":0.1,"2":0.8}}},"usage":{"total_input_tokens":100,"total_output_tokens":0}}`
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(reply)), Request: r}, nil
	})}
	v, err := s.askJev(context.Background(), time.Second, p, "", []string{"代码"}, before{Intent: "代码", Effort: "high", User: "实现功能", Reply: "已完成初版"}, true, "继续")
	if err != nil || v.Intent != "代码" || v.Score != 2 {
		t.Fatalf("classifier: %+v %v", v, err)
	}
}
