# P2 — J48 2+3 Progressive Merge

Approved transition: `J48:merge:wangan_1:ramp_41:end`, with two-lane
`ramp_41` entering three-lane `wangan_1` on the lower connected deck.

At the nearest authoritative overlap sample, the rendered surfaces are
75.776 m (`ramp_41`) and 75.972 m (`wangan_1`); collision decks are 75.777 m
and 75.974 m. At the crossable opening they are 76.229/76.317 m, after which
the ramp collision corridor defers to the single Wangan deck.

The corrected implementation uses the exact rendered opening at host station
`30965.993` and the real ramp ownership terminal at `31113.061`. Both ramp
lanes transfer as one rigid-width carriageway between those landmarks; neither
lane begins absorption during that handoff. The minimum sampled pre-handoff
lane-boundary width is 3.540 m.

The implemented sequence is:

`2-lane ramp + 3-lane host → 5 lanes → 4 lanes → 3 stable host lanes`

## Visual evidence

1. [Final developer-map pins](p2-00-developer-map-pins.png)
2. [Plan view of the selected lower junction](p2-01-plan-lower-junction.png)
3. [Two normal-width ramp lanes](p2-02-ramp-approach.png)
4. [Temporary five-lane section](p2-03-five-lane.png)
5. [First absorption, 5→4](p2-04-five-to-four.png)
6. [Stable four-lane section](p2-05-four-lane.png)
7. [Second absorption, 4→3](p2-06-four-to-three.png)
8. [Stable final three-lane Wangan](p2-07-final-three.png)
9. [Connected road-collision hitbox](p2-08-road-hitbox.png)
10. [Annotated true-handoff plan](p2-09-handoff-debug-plan.png)

The annotated plan shows `OPENING -> HANDOFF / FULL 5 START -> FULL 5 END /
FIRST ABSORPTION -> SECOND ABSORPTION -> STABLE 3-LANE`, all five centre paths,
and sampled widths for both ramp-origin lanes. The focused handoff, model,
geometry/paint/collision, both-lane vehicle traversal, and guardrail probes all
pass. Both `ramp_41` lanes traverse into `wangan_1` with zero collision events
and zero wall correction.
