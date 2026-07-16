# Progressive Merge Connection Audit

Generated deterministically from the runtime graph and the authoritative
junction-zone measurements on base `1a80b1b2be8f7e4e25b923de3a79413c302b7e91`.

## Summary

- Connections: 56 (27 merges, 29 diverges)
- Side: 19 left, 37 right
- Automatic/curved suitable: 2
- Manual review: 54
- Audited/pinned candidates: exactly 4
- Active same-level prototypes: 1
- Deferred multi-level/manual candidates: 3

- curved but suitable: 1
- deck-ownership incompatibility: 52
- manual review required: 54
- manual-review: 3
- multi-lane diverge: 12
- multi-lane merge: 11
- multi-level-transition: 5
- same-level-simple: 4
- simple 1-lane diverge: 17
- simple 1-lane merge: 16
- tangent mismatch too severe: 4
- transition too short: 2
- vertical-ramp-complex: 44

## P2 exhaustive same-level 2+2 merge search

The runtime graph contains 27 merges. Exact lane-count filtering
leaves 5 serious 2-lane-host + 2-lane-branch
candidates. Authoritative render/collision deck classification accepts
**0**. The ranking below is diagnostic only: a lower
score identifies the closest source geometry, but cannot override a failed
same-deck invariant.

| Rank | Junction | Traffic route pair | World X, Y, Z | Approach m | Parallel m | Max absorption m | Edge ΔY m | Grade Δ % | Bank Δ ° | Tangent Δ ° | Curvature °/100 m | Rejection |
| ---: | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | `J5:merge:c1_0:r6_3:end` | `r6_3 -> c1_0` | 595.11, 51.64, 463.91 | 1756.43 | 140 | 160 | 1.033 | 3.65 | 5.61 | 19.98 | 54.04 | 3 overlap samples lose deck ownership before lateral separation; 1.033 m maximum deck-edge separation; 3.65% maximum relative grade; 19.98 deg maximum tangent mismatch; 54.04 deg/100 m source curvature |
| 2 | `J1:merge:c1_2:c1_6:end` | `c1_6 -> c1_2` | -1144.45, 50.99, -3025.86 | 203.7 | 104 | 104 | 1.931 | 8.47 | 3.94 | 11.38 | 23.54 | 9 overlap samples lose deck ownership before lateral separation; 1.931 m maximum deck-edge separation; 8.47% maximum relative grade; deck ownership disconnects and reconnects inside the interaction |
| 3 | `J0:merge:c1_0:c1_3:end` | `c1_3 -> c1_0` | -897.45, 52.37, -2806.42 | 283.31 | 128 | 124 | 2.62 | 8.34 | 6.97 | 11.02 | 18.32 | 9 overlap samples lose deck ownership before lateral separation; 2.620 m maximum deck-edge separation; 8.34% maximum relative grade; measured source span never reaches clean lateral separation; deck ownership disconnects and reconnects inside the interaction |
| 4 | `J33:merge:r6_0:ramp_22:end` | `ramp_22 -> r6_0` | 962.38, 60.26, 152.46 | 492.38 | 128 | 124 | 2.924 | 13.05 | 3.8 | 9.99 | 56.31 | 19 overlap samples lose deck ownership before lateral separation; 2.924 m maximum deck-edge separation; 13.05% maximum relative grade; 56.31 deg/100 m source curvature; measured source span never reaches clean lateral separation |
| 5 | `J16:merge:r1_3:ramp_10:end` | `ramp_10 -> r1_3` | -1919.32, 46.54, -12267.59 | 1889.31 | 168 | 136 | 2.507 | 12.76 | 5.73 | 6.45 | 13.83 | transfer is not one shared render/collision deck; 12 overlap samples lose deck ownership before lateral separation; 2.507 m maximum deck-edge separation; 12.76% maximum relative grade; measured source span never reaches clean lateral separation; deck ownership disconnects and reconnects inside the interaction |

**Decision: no-valid-candidate.** Per the P2 brief, no route is promoted and
no prototype/developer-map configuration is changed when this gate has no
valid candidate. Detailed travel-order profiles and runtime images are in
[P2-CANDIDATE-REPORT.md](P2-CANDIDATE-REPORT.md).

## Selected representative prototype set

| Junction ID | Traffic route pair | Side | Host/branch lanes | Status | Classification | World X, Y, Z |
| --- | --- | --- | ---: | --- | --- | --- |
| `J0:merge:c1_0:c1_3:end` | `c1_3 -> c1_0` | left | 2/2 | deferred | vertical-ramp-complex | -897.45, 52.37, -2806.42 |
| `J2:diverge:c1_0:r1_0:start` | `c1_0 -> r1_0` | left | 2/2 | active | same-level-simple | -1094.38, 57.33, -3014.18 |
| `J8:merge:r11_0:ramp_1:end` | `ramp_1 -> r11_0` | right | 2/1 | deferred | vertical-ramp-complex | -1128.45, 73.04, -3825.43 |
| `J10:merge:wangan_1:ramp_3:end` | `ramp_3 -> wangan_1` | right | 3/2 | deferred | vertical-ramp-complex | 696.08, 29.71, -5832.86 |

All four are reachable through stable P1-P4 developer-map pins. P4 is the only
active same-level prototype; P1-P3 retain legacy geometry and are visibly
classified as deferred/manual. The classifier consumes the renderer's own
cross-section ownership: an ownership break while pavement still overlaps in
plan is a multi-level transition, even if the short transfer opening itself is
nearly level.

## Complete same-level catalogue

Widths, banking, curvature, exact A–B intervals, rail intervals, source-quality
reasons, and world coordinates are retained in
`.devtests/progressive-merge-audit.json`.

| Junction ID | Traffic route pair | Side | H/B lanes | Crossable m | Parallel m | Tangent ° | Opening ΔY m | Suitability | Classifications |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| `J0:merge:c1_0:c1_3:end` | `c1_3 -> c1_0` | left | 2/2 | 116 | 128 | 0.06 | 0.169 | manual-review | multi-lane merge, vertical-ramp-complex, deck-ownership incompatibility, manual review required |
| `J1:merge:c1_2:c1_6:end` | `c1_6 -> c1_2` | right | 2/2 | 96 | 104 | 0.02 | 0.254 | manual-review | multi-lane merge, vertical-ramp-complex, deck-ownership incompatibility, manual review required |
| `J2:diverge:c1_0:r1_0:start` | `c1_0 -> r1_0` | left | 2/2 | 152 | 120 | 0.44 | 0.53 | curved-suitable | multi-lane diverge, same-level-simple, curved but suitable |
| `J3:diverge:c1_2:r1_3:start` | `c1_2 -> r1_3` | right | 2/2 | 168 | 124 | 0.08 | 0.404 | manual-review | multi-lane diverge, multi-level-transition, deck-ownership incompatibility, manual review required |
| `J4:diverge:c1_2:r6_0:start` | `c1_2 -> r6_0` | right | 2/2 | 180 | 152 | 3.88 | 0.372 | manual-review | multi-lane diverge, vertical-ramp-complex, deck-ownership incompatibility, manual review required |
| `J5:merge:c1_0:r6_3:end` | `r6_3 -> c1_0` | left | 2/2 | 160 | 140 | 0.05 | 0.377 | manual-review | multi-lane merge, vertical-ramp-complex, deck-ownership incompatibility, manual review required |
| `J6:diverge:r1_3:ramp_0:start` | `r1_3 -> ramp_0` | right | 2/1 | 76 | 72 | 0 | 0.408 | manual-review | simple 1-lane diverge, vertical-ramp-complex, deck-ownership incompatibility, manual review required |
| `J7:diverge:r11_0:ramp_1:start` | `r11_0 -> ramp_1` | right | 2/1 | 76 | 80 | 0 | 0.195 | manual-review | simple 1-lane diverge, vertical-ramp-complex, deck-ownership incompatibility, manual review required |
| `J8:merge:r11_0:ramp_1:end` | `ramp_1 -> r11_0` | right | 2/1 | 20 | 76 | 0.84 | 0.185 | manual-review | simple 1-lane merge, vertical-ramp-complex, deck-ownership incompatibility, manual review required |
| `J9:diverge:wangan_0:ramp_2:start` | `wangan_0 -> ramp_2` | right | 3/2 | 128 | 136 | 0 | 0.127 | manual-review | multi-lane diverge, vertical-ramp-complex, deck-ownership incompatibility, manual review required |
| `J10:merge:wangan_1:ramp_3:end` | `ramp_3 -> wangan_1` | right | 3/2 | 168 | 172 | 0 | 0.182 | manual-review | multi-lane merge, vertical-ramp-complex, deck-ownership incompatibility, manual review required |
| `J11:diverge:c1_2:ramp_5:start` | `c1_2 -> ramp_5` | right | 2/1 | 68 | 68 | 0.77 | 0.348 | manual-review | simple 1-lane diverge, vertical-ramp-complex, deck-ownership incompatibility, manual review required |
| `J12:diverge:wangan_0:ramp_7:start` | `wangan_0 -> ramp_7` | right | 3/2 | 168 | 140 | 0.01 | 0.08 | manual-review | multi-lane diverge, vertical-ramp-complex, deck-ownership incompatibility, manual review required |
| `J13:diverge:wangan_0:ramp_8:start` | `wangan_0 -> ramp_8` | right | 3/2 | 176 | 144 | 0.01 | 0.547 | manual-review | multi-lane diverge, vertical-ramp-complex, deck-ownership incompatibility, manual review required |
| `J14:merge:wangan_1:ramp_9:end` | `ramp_9 -> wangan_1` | right | 3/2 | 140 | 148 | 0.05 | 0.141 | manual-review | multi-lane merge, vertical-ramp-complex, deck-ownership incompatibility, manual review required |
| `J15:diverge:wangan_1:ramp_10:start` | `wangan_1 -> ramp_10` | right | 3/2 | 164 | 152 | 0.01 | 0.228 | manual-review | multi-lane diverge, vertical-ramp-complex, deck-ownership incompatibility, manual review required |
| `J16:merge:r1_3:ramp_10:end` | `ramp_10 -> r1_3` | right | 2/2 | 28 | 168 | 0.02 | 0.18 | manual-review | multi-lane merge, manual-review, deck-ownership incompatibility, manual review required |
| `J17:diverge:r1_2:ramp_11:start` | `r1_2 -> ramp_11` | left | 2/1 | 156 | 164 | 0.31 | 0.222 | manual-review | simple 1-lane diverge, manual-review, deck-ownership incompatibility, manual review required |
| `J18:merge:r1_2:ramp_11:end` | `ramp_11 -> r1_2` | left | 2/1 | 16 | 164 | 1.27 | 0.141 | manual-review | simple 1-lane merge, vertical-ramp-complex, deck-ownership incompatibility, manual review required |
| `J19:diverge:r1_3:ramp_12:start` | `r1_3 -> ramp_12` | left | 2/1 | 140 | 148 | 1.38 | 0.143 | manual-review | simple 1-lane diverge, vertical-ramp-complex, deck-ownership incompatibility, manual review required |
| `J20:merge:r1_3:ramp_12:end` | `ramp_12 -> r1_3` | left | 2/1 | 68 | 228 | 0.51 | 0.208 | manual-review | simple 1-lane merge, vertical-ramp-complex, deck-ownership incompatibility, manual review required |
| `J21:diverge:wangan_1:ramp_13:start` | `wangan_1 -> ramp_13` | left | 3/1 | 12 | 136 | 0.08 | 0.187 | manual-review | simple 1-lane diverge, vertical-ramp-complex, deck-ownership incompatibility, manual review required |
| `J22:diverge:wangan_1:ramp_14:start` | `wangan_1 -> ramp_14` | right | 3/2 | 172 | 176 | 0 | 0.198 | manual-review | multi-lane diverge, vertical-ramp-complex, deck-ownership incompatibility, manual review required |
| `J23:diverge:wangan_0:ramp_15:start` | `wangan_0 -> ramp_15` | right | 3/1 | 180 | 140 | 0.07 | 0.28 | suitable | simple 1-lane diverge, same-level-simple |
| `J24:merge:wangan_0:ramp_16:end` | `ramp_16 -> wangan_0` | right | 3/1 | 16 | 180 | 0 | 0.199 | manual-review | simple 1-lane merge, vertical-ramp-complex, deck-ownership incompatibility, manual review required |
| `J25:diverge:k5_1:ramp_17:start` | `k5_1 -> ramp_17` | left | 2/1 | 68 | 72 | 0.19 | 0.131 | manual-review | simple 1-lane diverge, vertical-ramp-complex, deck-ownership incompatibility, manual review required |
| `J26:merge:k1_1:ramp_17:end` | `ramp_17 -> k1_1` | left | 2/1 | 24 | 112 | 0.1 | 0.185 | manual-review | simple 1-lane merge, vertical-ramp-complex, deck-ownership incompatibility, manual review required |
| `J27:diverge:r6_0:ramp_18:start` | `r6_0 -> ramp_18` | right | 2/1 | 40 | 192 | 4.38 | 0.18 | manual-review | simple 1-lane diverge, tangent mismatch too severe, same-level-simple, manual review required |
| `J28:merge:r6_0:ramp_19:end` | `ramp_19 -> r6_0` | right | 2/1 | 96 | 160 | 0 | 0.177 | manual-review | simple 1-lane merge, vertical-ramp-complex, deck-ownership incompatibility, manual review required |
| `J29:diverge:r6_3:ramp_20:start` | `r6_3 -> ramp_20` | right | 2/2 | 132 | 136 | 0.04 | 0.179 | manual-review | multi-lane diverge, vertical-ramp-complex, deck-ownership incompatibility, manual review required |
| `J30:diverge:r6_0:ramp_21:start` | `r6_0 -> ramp_21` | left | 2/1 | 56 | 84 | 4.38 | 0.15 | manual-review | simple 1-lane diverge, vertical-ramp-complex, deck-ownership incompatibility, manual review required |
| `J31:merge:ramp_18:ramp_21:end` | `ramp_21 -> ramp_18` | left | 1/1 | 24 | 88 | 1.3 | 0.144 | manual-review | simple 1-lane merge, tangent mismatch too severe, vertical-ramp-complex, deck-ownership incompatibility, manual review required |
| `J32:diverge:c1_0:ramp_22:start` | `c1_0 -> ramp_22` | left | 2/2 | 172 | 136 | 0 | 0.671 | manual-review | multi-lane diverge, multi-level-transition, deck-ownership incompatibility, manual review required |
| `J33:merge:r6_0:ramp_22:end` | `ramp_22 -> r6_0` | right | 2/2 | 124 | 128 | 0.03 | 0.174 | manual-review | multi-lane merge, vertical-ramp-complex, deck-ownership incompatibility, manual review required |
| `J34:diverge:r9_1:ramp_25:start` | `r9_1 -> ramp_25` | right | 2/1 | 160 | 164 | 0.04 | 0.23 | manual-review | simple 1-lane diverge, vertical-ramp-complex, deck-ownership incompatibility, manual review required |
| `J35:merge:r9_0:ramp_25:end` | `ramp_25 -> r9_0` | right | 2/1 | 60 | 168 | 1.07 | 0.203 | manual-review | simple 1-lane merge, vertical-ramp-complex, deck-ownership incompatibility, manual review required |
| `J36:diverge:r6_3:ramp_27:start` | `r6_3 -> ramp_27` | right | 2/1 | 52 | 48 | 0.62 | 0.173 | manual-review | simple 1-lane diverge, transition too short, tangent mismatch too severe, vertical-ramp-complex, deck-ownership incompatibility, manual review required |
| `J37:merge:c1_2:ramp_29:end` | `ramp_29 -> c1_2` | right | 2/1 | 68 | 64 | 0.01 | 0.49 | manual-review | simple 1-lane merge, vertical-ramp-complex, deck-ownership incompatibility, manual review required |
| `J38:merge:wangan_0:ramp_30:end` | `ramp_30 -> wangan_0` | right | 3/2 | 152 | 156 | 0 | 0.159 | manual-review | multi-lane merge, vertical-ramp-complex, deck-ownership incompatibility, manual review required |
| `J39:merge:r6_3:ramp_31:end` | `ramp_31 -> r6_3` | right | 2/1 | 40 | 60 | 0.03 | 0.137 | manual-review | simple 1-lane merge, vertical-ramp-complex, deck-ownership incompatibility, manual review required |
| `J40:merge:r1_2:ramp_32:end` | `ramp_32 -> r1_2` | left | 2/1 | 156 | 160 | 0.01 | 0.191 | manual-review | simple 1-lane merge, vertical-ramp-complex, deck-ownership incompatibility, manual review required |
| `J41:diverge:k5_1:ramp_35:start` | `k5_1 -> ramp_35` | right | 2/1 | 148 | 172 | 0.13 | 0.124 | manual-review | simple 1-lane diverge, vertical-ramp-complex, deck-ownership incompatibility, manual review required |
| `J42:merge:k1_0:ramp_35:end` | `ramp_35 -> k1_0` | left | 2/1 | 100 | 148 | 2.63 | 0.175 | manual-review | simple 1-lane merge, vertical-ramp-complex, deck-ownership incompatibility, manual review required |
| `J43:diverge:k1_0:ramp_36:start` | `k1_0 -> ramp_36` | left | 2/2 | 68 | 136 | 0 | 0.02 | manual-review | multi-lane diverge, vertical-ramp-complex, deck-ownership incompatibility, manual review required |
| `J44:diverge:r1_2:ramp_37:start` | `r1_2 -> ramp_37` | right | 2/1 | 84 | 68 | 0.01 | 0.175 | manual-review | simple 1-lane diverge, multi-level-transition, deck-ownership incompatibility, manual review required |
| `J45:merge:r1_2:ramp_37:end` | `ramp_37 -> r1_2` | right | 2/1 | 28 | 80 | 0.63 | 0.163 | manual-review | simple 1-lane merge, manual-review, deck-ownership incompatibility, manual review required |
| `J46:diverge:r6_0:ramp_39:start` | `r6_0 -> ramp_39` | right | 2/1 | 76 | 80 | 0.59 | 0.259 | manual-review | simple 1-lane diverge, vertical-ramp-complex, deck-ownership incompatibility, manual review required |
| `J47:merge:r6_3:ramp_40:end` | `ramp_40 -> r6_3` | right | 2/1 | 100 | 108 | 0.04 | 0.128 | manual-review | simple 1-lane merge, vertical-ramp-complex, deck-ownership incompatibility, manual review required |
| `J48:merge:wangan_1:ramp_41:end` | `ramp_41 -> wangan_1` | right | 3/2 | 144 | 136 | 0.32 | 0.161 | manual-review | multi-lane merge, vertical-ramp-complex, deck-ownership incompatibility, manual review required |
| `J49:diverge:k1_0:ramp_42:start` | `k1_0 -> ramp_42` | right | 2/1 | 84 | 88 | 2.04 | 0.171 | manual-review | simple 1-lane diverge, multi-level-transition, deck-ownership incompatibility, manual review required |
| `J50:merge:k1_0:ramp_42:end` | `ramp_42 -> k1_0` | right | 2/1 | 104 | 76 | 0.01 | 0.219 | manual-review | simple 1-lane merge, multi-level-transition, deck-ownership incompatibility, manual review required |
| `J51:diverge:r1_0:ramp_43:start` | `r1_0 -> ramp_43` | left | 2/1 | 32 | 72 | 0.01 | 0.178 | manual-review | simple 1-lane diverge, vertical-ramp-complex, deck-ownership incompatibility, manual review required |
| `J52:merge:r1_3:ramp_43:end` | `ramp_43 -> r1_3` | left | 2/1 | 68 | 76 | 0.09 | 0.138 | manual-review | simple 1-lane merge, vertical-ramp-complex, deck-ownership incompatibility, manual review required |
| `J53:merge:ramp_27:ramp_46:end` | `ramp_46 -> ramp_27` | left | 1/2 | 44 | 36 | 0.08 | 0.199 | manual-review | multi-lane merge, transition too short, tangent mismatch too severe, same-level-simple, manual review required |
| `J54:diverge:r1_2:ramp_47:start` | `r1_2 -> ramp_47` | right | 2/2 | 124 | 116 | 0.45 | 0.562 | manual-review | multi-lane diverge, vertical-ramp-complex, deck-ownership incompatibility, manual review required |
| `J55:merge:wangan_0:ramp_47:end` | `ramp_47 -> wangan_0` | right | 3/2 | 156 | 124 | 0 | 0.171 | manual-review | multi-lane merge, vertical-ramp-complex, deck-ownership incompatibility, manual review required |
