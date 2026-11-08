# Invalid runs (kept for transparency)

These runs were produced before the fixes in decision D-023 (`research/decision-log.md`) and must not be used:

- `ablation-test-pristine-bug`, `ablation-test-postfreeze-pristine-bug`: the ablation runner evaluated every variant against the pristine base snapshot instead of each task's single-bug snapshot.
- `final-test-stale-snippets`, `final-test-budget2000-stale-snippets`: rankings are valid and identical to the re-runs, but custom_graph/hybrid native contexts could contain source from another snapshot (path-keyed line cache), so native token counts were slightly off.

Raw outputs were removed; `metrics.json` and `report.md` are kept.
