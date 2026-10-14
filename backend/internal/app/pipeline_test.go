package app

import (
	"testing"
	"time"
)

func TestEnqueueDeduplicatesInflightNodes(t *testing.T) {
	p := newPipeline(nil)
	for range 5 {
		p.enqueue("n1") // Chrome can fire several tab events for one page
	}
	if got := len(p.queue); got != 1 {
		t.Fatalf("queued %d times, want 1", got)
	}
	<-p.queue
	p.done("n1")
	p.enqueue("n1")
	if got := len(p.queue); got != 1 {
		t.Fatalf("after done, queued %d, want 1", got)
	}
}

func TestScheduleRetryStopsAfterBackoffList(t *testing.T) {
	p := newPipeline(nil)
	old := retryDelays
	retryDelays = []time.Duration{time.Hour} // one attempt; the timer never fires during the test
	defer func() { retryDelays = old }()
	if d, ok := p.scheduleRetry("n1"); !ok || d != time.Hour {
		t.Fatalf("first failure: got (%v,%v), want (1h,true)", d, ok)
	}
	if _, ok := p.scheduleRetry("n1"); ok {
		t.Fatal("second failure: expected retries to be exhausted")
	}
}
