# RS.8 performance evidence

Both commands exited 0. The root ran the existing transcript benchmark on an archived baseline and then immediately on frozen head, after owner tests and terminal processes exited. Baseline HEAD 0f80e91810f1a7dfaaa59ba4dfd4c9ef8d333f08 was verified as a commit. Relevant rendering source is identical to main 329ec80eace5af98d8e98958e953fa31ca87f431. Head is the uncommitted RS.1 through RS.9 worktree. No completion SHA is invented.

Commands used npx tsx --tsconfig tsconfig.runtime.json packages/coding-agent/test/streaming-render-bench.ts in /tmp/apex-rs8-trunk-bench and then the repository. Raw outputs are rs8-streaming-trunk.log and rs8-streaming-head.log.

The unchanged updateContent path measured 6.00/6.20/14.15 ms at trunk versus 12.37/18.26/30.06 ms at head. Full-frame histories 20/100/300 measured 11.36/26.52/101.12 ms versus 9.09/42.92/76.34 ms. Rebuild timings improved in all three head cases. Opposing movement and large differences on unchanged paths cannot establish a change-induced regression. This is an inference from source equivalence and the measured variability.

The host was not idle. A read-only process-name check showed unrelated Brave and several MainThread processes consuming CPU. No unrelated process was stopped. The required idle-host timing gate remains open; these measurements do not justify a no-regression claim.

The mounted production-layout command was npx tsx --tsconfig tsconfig.runtime.json .apex-code/verification/reachable-surfaces/rs8-panel-bench.ts. It exited 0. Raw output is rs8-panel-bench.log. Twenty-four cases cover histories 20/100/300, main/fullscreen, and absent/off/collapsed/expanded. Each samples 80 updateContent plus full render frames with a 6003-entry branch and 12-item list. All assertions passed. Mounted panel cases made one initial branch read, zero unchanged-frame reads, and one read after a replacement entry. Maximum panel rows were zero when absent/off, one collapsed, and six expanded. These structural results are established independently of latency.

Measured means ranged from 4.202 to 30.941 ms and p95 from 10.548 to 122.146 ms. Expanded was sometimes faster than absent or collapsed, so the timing variation prevents attributing incremental panel overhead. The smoke run used two frames and is explicitly excluded from timing evidence. Benchmark scripts and transcripts remain local artifacts for a reviewer to rerun on an idle host.

After the full suite exited 0, the root checked host activity again. Two instantaneous vmstat samples showed 67% and 62% CPU idle, with ongoing unrelated Brave activity and no remaining owner test process. This still does not establish an idle host. A second timing run under those conditions would not close the required gate; none was presented as clean evidence.
