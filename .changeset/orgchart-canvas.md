---
"@autonomos/dashboard": patch
---

feat(orgchart): drag to move around the Org Chart, zoom, Fit, and a map in the corner

The Org Chart is now a canvas. Drag empty space to move around it, pinch or
⌘-scroll to zoom (two-finger scroll moves it), and press Fit to see everyone.
A small map in the bottom-right corner shows the whole org in status colors and
the part you're looking at; click or drag it to jump. It appears only when the
chart is bigger than the pane.

The chart opens fitted, but never smaller than 60%, so a big org opens readable
at the top of the tree. Keys while the chart is focused: F fits, 0 is 100%,
+ and − zoom. Selecting an agent with the arrow keys keeps it on screen, and
message bubbles stay readable when you zoom out.

A click on empty space still never closes the details panel, and dragging a
card does nothing yet (it's saved for drag-to-reassign).
