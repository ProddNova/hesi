# P2 — J48 2+3 Progressive Merge

Approved transition: `J48:merge:wangan_1:ramp_41:end`, with two-lane
`ramp_41` entering three-lane `wangan_1` on the lower connected deck.

At the nearest authoritative overlap sample, the rendered surfaces are
75.776 m (`ramp_41`) and 75.972 m (`wangan_1`); collision decks are 75.777 m
and 75.974 m. The corrected handoff probe measures at most 0.017 m of height
switch error while ownership transfers to the single Wangan deck.

The corrected implementation derives topology from the true exterior lane
edge of the unchanged three-lane host. Physical opening begins at host station
`30935.105`; both ramp lanes reach their appended temporary slots and transfer
pavement/collision ownership at `30939.383`. The full five-lane carriageway
then remains stable until `31026.222`, before the first absorption. The first
5→4 transition ends at `31113.061`, the four-lane plateau ends at `31199.901`,
and the final 4→3 transition settles at `31286.740`.

The right-side temporary lane-centre ordering is `10.650, 7.100, 3.550,
0.000, -3.550 m`: two new ramp-origin slots outside the three original Wangan
slots. The minimum sampled ramp-lane width through handoff is 3.550 m.

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

The annotated plan shows the true three-lane host exterior edge, all five
temporary offsets, `OPENING -> HANDOFF / FULL 5 START -> FULL 5 END / FIRST
ABSORPTION -> SECOND ABSORPTION -> STABLE 3-LANE`, and sampled widths for both
ramp-origin lanes. The focused handoff, model, geometry/paint/collision,
both-lane vehicle traversal, and guardrail probes all pass. Both `ramp_41`
lanes traverse into `wangan_1` with zero collision events and zero wall
correction.
