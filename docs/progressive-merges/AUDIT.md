# Progressive Merge Connection Audit

Generated deterministically from the runtime graph and the authoritative
junction-zone measurements on base `e960f501776552cca3e46b911c7f46f684d45dfd`.

## Summary

- Connections: 56 (27 merges, 29 diverges)
- Side: 37 left, 19 right
- Automatic/curved suitable: 52
- Manual review: 4
- Selected prototypes: exactly 4

- curved but suitable: 22
- manual review required: 4
- multi-lane diverge: 12
- multi-lane merge: 11
- simple 1-lane diverge: 17
- simple 1-lane merge: 16
- tangent mismatch too severe: 4
- transition too short: 2

## Selected representative prototype set

| Junction ID | Traffic route pair | Side | Host/branch lanes | World X, Y, Z | Reason |
| --- | --- | --- | ---: | --- | --- |
| `J0:merge:c1_0:c1_3:end` | `c1_3 -> c1_0` | right | 2/2 | -897.45, 52.37, -2806.42 | two-to-two merge |
| `J2:diverge:c1_0:r1_0:start` | `c1_0 -> r1_0` | right | 2/2 | -1094.38, 57.33, -3014.18 | right-side diverge |
| `J8:merge:r11_0:ramp_1:end` | `ramp_1 -> r11_0` | left | 2/1 | -1128.45, 73.04, -3825.43 | one-to-two merge |
| `J10:merge:wangan_1:ramp_3:end` | `ramp_3 -> wangan_1` | left | 3/2 | 696.08, 29.71, -5832.86 | two-to-three merge |

All four are reachable in the developer map. Open it with **M**, enable labels,
then use the prototype pins added by the finishing phase; the coordinates above
remain the exact fallback teleport/search locations.

## Complete same-level catalogue

Widths, banking, curvature, exact A–B intervals, rail intervals, source-quality
reasons, and world coordinates are retained in
`.devtests/progressive-merge-audit.json`.

| Junction ID | Traffic route pair | Side | H/B lanes | Crossable m | Parallel m | Tangent ° | Opening ΔY m | Suitability | Classifications |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| `J0:merge:c1_0:c1_3:end` | `c1_3 -> c1_0` | right | 2/2 | 116 | 128 | 0.06 | 0.169 | suitable | multi-lane merge |
| `J1:merge:c1_2:c1_6:end` | `c1_6 -> c1_2` | left | 2/2 | 96 | 104 | 0.02 | 0.254 | suitable | multi-lane merge |
| `J2:diverge:c1_0:r1_0:start` | `c1_0 -> r1_0` | right | 2/2 | 152 | 120 | 0.44 | 0.53 | curved-suitable | multi-lane diverge, curved but suitable |
| `J3:diverge:c1_2:r1_3:start` | `c1_2 -> r1_3` | left | 2/2 | 168 | 124 | 0.08 | 0.404 | suitable | multi-lane diverge |
| `J4:diverge:c1_2:r6_0:start` | `c1_2 -> r6_0` | left | 2/2 | 180 | 152 | 3.88 | 0.372 | curved-suitable | multi-lane diverge, curved but suitable |
| `J5:merge:c1_0:r6_3:end` | `r6_3 -> c1_0` | right | 2/2 | 160 | 140 | 0.05 | 0.377 | curved-suitable | multi-lane merge, curved but suitable |
| `J6:diverge:r1_3:ramp_0:start` | `r1_3 -> ramp_0` | left | 2/1 | 76 | 72 | 0 | 0.408 | curved-suitable | simple 1-lane diverge, curved but suitable |
| `J7:diverge:r11_0:ramp_1:start` | `r11_0 -> ramp_1` | left | 2/1 | 76 | 80 | 0 | 0.195 | suitable | simple 1-lane diverge |
| `J8:merge:r11_0:ramp_1:end` | `ramp_1 -> r11_0` | left | 2/1 | 20 | 76 | 0.84 | 0.185 | curved-suitable | simple 1-lane merge, curved but suitable |
| `J9:diverge:wangan_0:ramp_2:start` | `wangan_0 -> ramp_2` | left | 3/2 | 128 | 136 | 0 | 0.127 | suitable | multi-lane diverge |
| `J10:merge:wangan_1:ramp_3:end` | `ramp_3 -> wangan_1` | left | 3/2 | 168 | 172 | 0 | 0.182 | suitable | multi-lane merge |
| `J11:diverge:c1_2:ramp_5:start` | `c1_2 -> ramp_5` | left | 2/1 | 68 | 68 | 0.77 | 0.348 | curved-suitable | simple 1-lane diverge, curved but suitable |
| `J12:diverge:wangan_0:ramp_7:start` | `wangan_0 -> ramp_7` | left | 3/2 | 168 | 140 | 0.01 | 0.08 | curved-suitable | multi-lane diverge, curved but suitable |
| `J13:diverge:wangan_0:ramp_8:start` | `wangan_0 -> ramp_8` | left | 3/2 | 176 | 144 | 0.01 | 0.547 | suitable | multi-lane diverge |
| `J14:merge:wangan_1:ramp_9:end` | `ramp_9 -> wangan_1` | left | 3/2 | 140 | 148 | 0.05 | 0.141 | suitable | multi-lane merge |
| `J15:diverge:wangan_1:ramp_10:start` | `wangan_1 -> ramp_10` | left | 3/2 | 164 | 152 | 0.01 | 0.228 | curved-suitable | multi-lane diverge, curved but suitable |
| `J16:merge:r1_3:ramp_10:end` | `ramp_10 -> r1_3` | left | 2/2 | 28 | 168 | 0.02 | 0.18 | suitable | multi-lane merge |
| `J17:diverge:r1_2:ramp_11:start` | `r1_2 -> ramp_11` | right | 2/1 | 156 | 164 | 0.31 | 0.222 | suitable | simple 1-lane diverge |
| `J18:merge:r1_2:ramp_11:end` | `ramp_11 -> r1_2` | right | 2/1 | 16 | 164 | 1.27 | 0.141 | curved-suitable | simple 1-lane merge, curved but suitable |
| `J19:diverge:r1_3:ramp_12:start` | `r1_3 -> ramp_12` | right | 2/1 | 140 | 148 | 1.38 | 0.143 | curved-suitable | simple 1-lane diverge, curved but suitable |
| `J20:merge:r1_3:ramp_12:end` | `ramp_12 -> r1_3` | right | 2/1 | 68 | 228 | 0.51 | 0.208 | suitable | simple 1-lane merge |
| `J21:diverge:wangan_1:ramp_13:start` | `wangan_1 -> ramp_13` | right | 3/1 | 12 | 136 | 0.08 | 0.187 | suitable | simple 1-lane diverge |
| `J22:diverge:wangan_1:ramp_14:start` | `wangan_1 -> ramp_14` | left | 3/2 | 172 | 176 | 0 | 0.198 | suitable | multi-lane diverge |
| `J23:diverge:wangan_0:ramp_15:start` | `wangan_0 -> ramp_15` | left | 3/1 | 180 | 140 | 0.07 | 0.28 | suitable | simple 1-lane diverge |
| `J24:merge:wangan_0:ramp_16:end` | `ramp_16 -> wangan_0` | left | 3/1 | 16 | 180 | 0 | 0.199 | suitable | simple 1-lane merge |
| `J25:diverge:k5_1:ramp_17:start` | `k5_1 -> ramp_17` | right | 2/1 | 68 | 72 | 0.19 | 0.131 | suitable | simple 1-lane diverge |
| `J26:merge:k1_1:ramp_17:end` | `ramp_17 -> k1_1` | right | 2/1 | 24 | 112 | 0.1 | 0.185 | suitable | simple 1-lane merge |
| `J27:diverge:r6_0:ramp_18:start` | `r6_0 -> ramp_18` | left | 2/1 | 40 | 192 | 4.38 | 0.18 | manual-review | simple 1-lane diverge, tangent mismatch too severe, manual review required |
| `J28:merge:r6_0:ramp_19:end` | `ramp_19 -> r6_0` | left | 2/1 | 96 | 160 | 0 | 0.177 | suitable | simple 1-lane merge |
| `J29:diverge:r6_3:ramp_20:start` | `r6_3 -> ramp_20` | left | 2/2 | 132 | 136 | 0.04 | 0.179 | curved-suitable | multi-lane diverge, curved but suitable |
| `J30:diverge:r6_0:ramp_21:start` | `r6_0 -> ramp_21` | right | 2/1 | 56 | 84 | 4.38 | 0.15 | curved-suitable | simple 1-lane diverge, curved but suitable |
| `J31:merge:ramp_18:ramp_21:end` | `ramp_21 -> ramp_18` | right | 1/1 | 24 | 88 | 1.3 | 0.144 | manual-review | simple 1-lane merge, tangent mismatch too severe, manual review required |
| `J32:diverge:c1_0:ramp_22:start` | `c1_0 -> ramp_22` | right | 2/2 | 172 | 136 | 0 | 0.671 | suitable | multi-lane diverge |
| `J33:merge:r6_0:ramp_22:end` | `ramp_22 -> r6_0` | left | 2/2 | 124 | 128 | 0.03 | 0.174 | curved-suitable | multi-lane merge, curved but suitable |
| `J34:diverge:r9_1:ramp_25:start` | `r9_1 -> ramp_25` | left | 2/1 | 160 | 164 | 0.04 | 0.23 | suitable | simple 1-lane diverge |
| `J35:merge:r9_0:ramp_25:end` | `ramp_25 -> r9_0` | left | 2/1 | 60 | 168 | 1.07 | 0.203 | suitable | simple 1-lane merge |
| `J36:diverge:r6_3:ramp_27:start` | `r6_3 -> ramp_27` | left | 2/1 | 52 | 48 | 0.62 | 0.173 | manual-review | simple 1-lane diverge, transition too short, tangent mismatch too severe, manual review required |
| `J37:merge:c1_2:ramp_29:end` | `ramp_29 -> c1_2` | left | 2/1 | 68 | 64 | 0.01 | 0.49 | suitable | simple 1-lane merge |
| `J38:merge:wangan_0:ramp_30:end` | `ramp_30 -> wangan_0` | left | 3/2 | 152 | 156 | 0 | 0.159 | suitable | multi-lane merge |
| `J39:merge:r6_3:ramp_31:end` | `ramp_31 -> r6_3` | left | 2/1 | 40 | 60 | 0.03 | 0.137 | curved-suitable | simple 1-lane merge, curved but suitable |
| `J40:merge:r1_2:ramp_32:end` | `ramp_32 -> r1_2` | right | 2/1 | 156 | 160 | 0.01 | 0.191 | suitable | simple 1-lane merge |
| `J41:diverge:k5_1:ramp_35:start` | `k5_1 -> ramp_35` | left | 2/1 | 148 | 172 | 0.13 | 0.124 | suitable | simple 1-lane diverge |
| `J42:merge:k1_0:ramp_35:end` | `ramp_35 -> k1_0` | right | 2/1 | 100 | 148 | 2.63 | 0.175 | curved-suitable | simple 1-lane merge, curved but suitable |
| `J43:diverge:k1_0:ramp_36:start` | `k1_0 -> ramp_36` | right | 2/2 | 68 | 136 | 0 | 0.02 | suitable | multi-lane diverge |
| `J44:diverge:r1_2:ramp_37:start` | `r1_2 -> ramp_37` | left | 2/1 | 84 | 68 | 0.01 | 0.175 | curved-suitable | simple 1-lane diverge, curved but suitable |
| `J45:merge:r1_2:ramp_37:end` | `ramp_37 -> r1_2` | left | 2/1 | 28 | 80 | 0.63 | 0.163 | curved-suitable | simple 1-lane merge, curved but suitable |
| `J46:diverge:r6_0:ramp_39:start` | `r6_0 -> ramp_39` | left | 2/1 | 76 | 80 | 0.59 | 0.259 | suitable | simple 1-lane diverge |
| `J47:merge:r6_3:ramp_40:end` | `ramp_40 -> r6_3` | left | 2/1 | 100 | 108 | 0.04 | 0.128 | suitable | simple 1-lane merge |
| `J48:merge:wangan_1:ramp_41:end` | `ramp_41 -> wangan_1` | left | 3/2 | 144 | 136 | 0.32 | 0.161 | suitable | multi-lane merge |
| `J49:diverge:k1_0:ramp_42:start` | `k1_0 -> ramp_42` | left | 2/1 | 84 | 88 | 2.04 | 0.171 | curved-suitable | simple 1-lane diverge, curved but suitable |
| `J50:merge:k1_0:ramp_42:end` | `ramp_42 -> k1_0` | left | 2/1 | 104 | 76 | 0.01 | 0.219 | suitable | simple 1-lane merge |
| `J51:diverge:r1_0:ramp_43:start` | `r1_0 -> ramp_43` | right | 2/1 | 32 | 72 | 0.01 | 0.178 | curved-suitable | simple 1-lane diverge, curved but suitable |
| `J52:merge:r1_3:ramp_43:end` | `ramp_43 -> r1_3` | right | 2/1 | 68 | 76 | 0.09 | 0.138 | curved-suitable | simple 1-lane merge, curved but suitable |
| `J53:merge:ramp_27:ramp_46:end` | `ramp_46 -> ramp_27` | right | 1/2 | 44 | 36 | 0.08 | 0.199 | manual-review | multi-lane merge, transition too short, tangent mismatch too severe, manual review required |
| `J54:diverge:r1_2:ramp_47:start` | `r1_2 -> ramp_47` | left | 2/2 | 124 | 116 | 0.45 | 0.562 | curved-suitable | multi-lane diverge, curved but suitable |
| `J55:merge:wangan_0:ramp_47:end` | `ramp_47 -> wangan_0` | left | 3/2 | 156 | 124 | 0 | 0.171 | curved-suitable | multi-lane merge, curved but suitable |
