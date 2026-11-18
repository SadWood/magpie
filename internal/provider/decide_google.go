package provider

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
)

// GoogleDecision is the Gemini Developer API's decision model, not a chat model.
const GoogleDecision = "gemini-decision-1"

func googleDecides(base string) bool {
	u, err := url.Parse(base)
	return err == nil && u.Scheme == "https" && u.Host == "generativelanguage.googleapis.com" && strings.TrimRight(u.Path, "/") == "/v1beta"
}

// googleDecisionBase enables decisions for Google's own key endpoint only.
// An explicit decision URL, a relay, Vertex and subscription accounts keep
// their own protocol and credentials.
func (p Provider) googleDecisionBase() string {
	if p.Account != nil || p.IsRemoteMagpie() || p.IsVertex() {
		return ""
	}
	base := strings.TrimSuffix(strings.TrimRight(p.Chat, "/"), "/openai")
	if googleDecides(base) {
		return base
	}
	return ""
}

// DecideProtocol selects the signing scheme for a decision request.
func (p Provider) DecideProtocol() Protocol {
	if p.DecideVia() == ViaGoogle {
		return Gemini
	}
	return Chat
}

// PrepareDecideAsk translates System One into the vendor's wire format.
// Google's input is text, not System One's arbitrary state: objects are
// serialized whole, so classifier context is not lost. Media is refused rather
// than silently discarded; native Google media blocks need a separate adapter.
func PrepareDecideAsk(via, model string, body []byte) ([]byte, error) {
	if via != ViaGoogle {
		return DecideAsk(via, model, body), nil
	}
	var q map[string]json.RawMessage
	if json.Unmarshal(body, &q) != nil || q == nil {
		return nil, fmt.Errorf("Google Decisions needs a JSON object")
	}
	for k := range q {
		if k != "model" && k != "state" && k != "questions" {
			return nil, fmt.Errorf("Google Decisions adapter does not support %q", k)
		}
	}
	state, ok := q["state"]
	if !ok || string(state) == "null" {
		return nil, fmt.Errorf("Google Decisions needs state")
	}
	var input string
	if json.Unmarshal(state, &input) != nil {
		input = string(state)
	}
	var qs map[string]map[string]json.RawMessage
	if json.Unmarshal(q["questions"], &qs) != nil || len(qs) == 0 || len(qs) > 1000 {
		return nil, fmt.Errorf("Google Decisions needs 1 to 1000 questions")
	}
	for key, question := range qs {
		if !googleQuestionKey(key) {
			return nil, fmt.Errorf("Google Decisions question names need 1 to 64 ASCII letters, digits, underscores or hyphens")
		}
		var kind string
		json.Unmarshal(question["type"], &kind)
		if kind == "choice" {
			var criteria map[string]json.RawMessage
			if json.Unmarshal(question["criteria"], &criteria) != nil || len(criteria) < 2 || len(criteria) > 255 {
				return nil, fmt.Errorf("Google Decisions choice %q needs 2 to 255 options", key)
			}
			for name, value := range criteria {
				if string(value) == "null" {
					criteria[name] = json.RawMessage(`""`)
				} else {
					var description string
					if json.Unmarshal(value, &description) != nil {
						return nil, fmt.Errorf("Google Decisions choice %q needs string option descriptions", key)
					}
				}
			}
			question["criteria"], _ = json.Marshal(criteria)
		}
		if kind == "score" {
			var criteria []string
			if json.Unmarshal(question["criteria"], &criteria) != nil || len(criteria) < 2 || len(criteria) > 255 {
				return nil, fmt.Errorf("Google Decisions score %q needs 2 to 255 level descriptions", key)
			}
			for _, level := range criteria {
				if strings.TrimSpace(level) == "" {
					return nil, fmt.Errorf("Google Decisions score %q has an empty level description", key)
				}
			}
		}
	}
	return json.Marshal(map[string]any{"model": strings.TrimPrefix(model, "models/"), "input": input, "questions": qs})
}

func googleQuestionKey(s string) bool {
	if len(s) == 0 || len(s) > 64 {
		return false
	}
	for _, c := range s {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_' || c == '-') {
			return false
		}
	}
	return true
}

// googleDecisionAnswer preserves the answers (including confidence and the
// score legend), changing only token-usage names for the gateway's accounting.
func googleDecisionAnswer(b []byte) []byte {
	var out map[string]json.RawMessage
	if json.Unmarshal(b, &out) != nil || out["answers"] == nil {
		return b
	}
	var usage map[string]json.RawMessage
	if json.Unmarshal(out["usage"], &usage) == nil && usage != nil {
		if n, ok := usage["total_input_tokens"]; ok {
			usage["input_tokens"] = n
		}
		if n, ok := usage["total_output_tokens"]; ok {
			usage["output_tokens"] = n
		}
		out["usage"], _ = json.Marshal(usage)
	}
	result, _ := json.Marshal(out)
	return result
}
