package usage

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/yetone/magpie/internal/catalog"
	"github.com/yetone/magpie/internal/provider"
)

// The ledger lists a period's calls newest first, each with the model
// asked for, sent and served, marked when another answered, and its cost
// at list price; it filters by agent, failure and text; a record written
// before the requested and served models were kept still loads; the CSV
// has one row a call.
func TestLedger(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
	t.Setenv("XDG_CACHE_HOME", filepath.Join(home, ".cache"))
	// a models.dev catalog pricing relay's sol: $2 in, $8 out, $0.5 a
	// cached read, $2.5 a cache write, per million
	os.MkdirAll(filepath.Dir(catalog.CachePath()), 0o755)
	os.WriteFile(catalog.CachePath(), []byte(`{"vendor":{"id":"vendor","models":{"sol":{"id":"sol","cost":{"input":2,"output":8,"cache_read":0.5,"cache_write":2.5}}}}}`), 0o644)
	if err := provider.Save(provider.Provider{ID: "relay", Name: "Relay", Key: "k", Chat: "https://relay.example/v1", Catalog: "vendor"}); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	old := `{"t":"` + now.Add(-3*time.Hour).Format(time.RFC3339Nano) + `","agent":"claude","provider":"relay","host":"relay.example","model":"sol","in":1000,"out":100,"ms":900,"status":200}`
	os.MkdirAll(filepath.Dir(Path()), 0o755)
	if err := os.WriteFile(Path(), []byte(old+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	Append(Record{Time: now.Add(-2 * time.Hour), Agent: "codex", Provider: "relay", Host: "relay.example", Model: "sol", Requested: "fast", Served: "luna",
		Input: 2000, Output: 500, CacheRead: 4000, CacheWrite: 1000, Effort: "high", Millis: 3200, TTFT: 400, Status: 200, Session: "s1"})
	Append(Record{Time: now.Add(-1 * time.Hour), Agent: "codex", Provider: "relay", Host: "relay.example", Model: "sol", Requested: "relay/sol", Served: "sol-2026-01-01",
		Input: 10, Output: 1, Millis: 100, Status: 200})
	Append(Record{Time: now.Add(-30 * time.Minute), Agent: "codex", Provider: "relay", Host: "relay.example", Model: "sol", Requested: "fast", Millis: 50, Status: 429})
	Append(Record{Time: now.Add(-40 * 24 * time.Hour), Agent: "codex", Provider: "relay", Model: "sol", Input: 1}) // before the month

	rows, sum, agents := Ledger(Month, Filter{})
	if len(rows) != 4 || sum.Calls != 4 || sum.Errors != 1 || strings.Join(agents, ",") != "claude,codex" {
		t.Fatalf("rows %d, %+v, agents %v", len(rows), sum, agents)
	}
	if rows[0].Status != 429 || rows[3].Agent != "claude" {
		t.Fatalf("not newest first: %+v", rows)
	}
	sw := rows[2]
	if sw.Requested != "fast" || sw.Model != "sol" || sw.Served != "luna" || !sw.Swapped || !sw.Priced {
		t.Fatalf("swapped row %+v", sw)
	}
	if want := (2000*2 + 500*8 + 4000*0.5 + 1000*2.5) / 1e6; sw.Cost != want {
		t.Fatalf("cost %v, want %v", sw.Cost, want)
	}
	if rows[1].Swapped || rows[1].Served != "sol-2026-01-01" {
		t.Fatalf("a dated name is the same model: %+v", rows[1])
	}
	if rows[3].Requested != "" || rows[3].Served != "" || rows[3].Input != 1000 || !rows[3].Priced {
		t.Fatalf("old record %+v", rows[3])
	}
	if rows[0].Priced || rows[0].Cost != 0 {
		t.Fatalf("a call with no tokens has no cost: %+v", rows[0])
	}

	if rows, _, _ := Ledger(Month, Filter{Agent: "claude"}); len(rows) != 1 || rows[0].Agent != "claude" {
		t.Fatalf("agent filter: %+v", rows)
	}
	if rows, s, _ := Ledger(Month, Filter{Failed: true}); len(rows) != 1 || rows[0].Status != 429 || s.Calls != 1 {
		t.Fatalf("failed filter: %+v", rows)
	}
	if rows, _, _ := Ledger(Month, Filter{Query: "LUNA"}); len(rows) != 1 || rows[0].Served != "luna" {
		t.Fatalf("query filter: %+v", rows)
	}
	if rows, _, _ := Ledger(All, Filter{}); len(rows) != 5 {
		t.Fatalf("all: %d", len(rows))
	}

	var b strings.Builder
	if err := WriteCSV(&b, rows[1:3]); err != nil {
		t.Fatal(err)
	}
	want := strings.Join(CSVHeader, ",") + "\n" +
		rows[1].Time.Format(time.RFC3339) + ",codex,relay/sol,relay,relay.example,sol,sol-2026-01-01,false,,10,1,0,0,0,0.000028,100,,200,false,,\n" +
		rows[2].Time.Format(time.RFC3339) + ",codex,fast,relay,relay.example,sol,luna,true,high,2000,500,1000,4000,0,0.012500,3200,400,200,false,s1,\n"
	if b.String() != want {
		t.Fatalf("csv:\n%s\nwant:\n%s", b.String(), want)
	}
}
