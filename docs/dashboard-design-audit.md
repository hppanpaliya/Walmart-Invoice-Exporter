# Dashboard design audit

This is a visual and responsive-layout review, not a test of extraction or
spending calculations. Use synthetic data and check the packaged extension,
including the embedded Collect & Export panel and its settings.

## Findings on 8.9

Measured 130 screen states in packaged Chromium. That includes all seven
dashboard views, 11 viewport widths in light mode, four widths in dark mode,
enlarged text spacing at three widths, one empty state, and three settings
frame widths. Used synthetic history with unusually large totals and long
unbroken product names; checked actual screenshots as well as DOM geometry.
Pixel measurements reflect this fixture, not every possible invoice.

| Priority | Confirmed issue | What to change |
| --- | --- | --- |
| High | **Year in Review:** a seven-digit annual total crossed its card at several desktop widths, including by 113 px at 1280 px. The next tile painted over the trailing digits. The Saved tile can also spill. | Give headline amounts intrinsic room with a responsive grid. Wrap the delta independently. Keep the exact amount readable, not ellipsized. |
| High | **Overview:** at 1100 px, the five-card row remains next to the 400 px rail. With the stress data the delta crossed its tile by 39 px, and three secondary amounts by up to 14 px. At 390 px, the stat grid added 23 px of page overflow. | Respond to the width of the content column rather than the window alone. Switch to fewer cards per row sooner and use shrinkable grid tracks. A two-column `minmax(0, 1fr)` probe removed the 390 px page overflow. |
| High | **Missed Items:** the whole view widened past the viewport, not just its data tables: 209 px of page overflow at 390 px and 279 px at 320 px. The introduction and cards run off-screen. | Constrain `.mis-page` to the available column and keep table scrolling inside `.mis-scroll`. A temporary `width: 100%` probe removed the view's contribution to page overflow. |
| High | **Categories:** the page scrolled horizontally by 124 px at 390 px, even though the tables had their own scrollers. At 1100 px a chevron also extended about 5 px past its card's inner edge. | Give the absolutely positioned screen-reader labels a positioned ancestor inside their row, and switch the summary grid to its compact layout based on available column width. Anchoring the labels removed the 390 px page overflow in a temporary probe. |
| High | **Shared header:** at 320 px the Settings button is outside the initial viewport, and the header contributes 44 px of horizontal overflow. Increased text spacing also breaks the header at 390 px. Deep links can leave the selected pill outside the visible nav strip. | Wrap or stack header actions; use a compact navigation control or reveal the current pill without scrolling the entire page. |
| Medium | **Items:** the unwrappable result count runs past its card by 23 px at 320 px, and farther with the spacing override. **Orders:** order summaries and expanded invoice names are deliberately ellipsized; the order table itself stays contained. | Let the Items count wrap. Keep the Orders scroller, but provide full product names in the expanded detail without relying on pointer-only tooltips. |
| Medium | **Collect & Export:** at 1100×600, the rail iframe ended at y=707 because it retained its 600 px minimum height. In the 320 px settings case, the iframe also had 10 px of internal horizontal overflow. | Fit the desktop rail to the available height and let its body scroll while keeping primary actions in view. Reflow settings controls at narrow widths. |

The stress fixture did not produce page-level horizontal overflow in Trends
or Orders at 390 px; the Trends heatmap and Orders table used local scrollers.
That is intentional containment, not evidence that every control is
keyboard-reachable or that every chart label fits. The layout probes were
temporary; no production UI was changed in this audit.

Still to test: actual browser zoom, Firefox, classic scrollbars, full
keyboard/focus and contrast checks, account rename and multiple providers,
and edge-positioned chart tooltips. The 320 px runs test viewport reflow,
not browser zoom itself. This is not a WCAG conformance assessment.

## Implementation plan and progress

1. **Shared layout:** size card grids to the dashboard column, wrap header
   controls, keep the active tab visible, and use measured sticky offsets.
2. **View layouts:** keep headline amounts and comparisons inside their
   cards, anchor Categories labels, keep Missed Items tables in local
   scrollers, and wrap the Items count and expanded invoice names.
3. **Panel:** fit the embedded rail into short desktop windows and leave
   enough width for the narrow settings layout.
4. **Regression coverage:** exercise the seven views with long names and
   large amounts around the shell breakpoints and at 390/320 px; verify
   text spacing, the rail bottom, settings, and active navigation.
5. **Follow-up QA:** run actual browser zoom and Firefox, verify focus and
   keyboard scrolling through sticky regions, and inspect chart tooltip
   placement and contrast.

Steps 1–4 are implemented locally. The 130-state Chromium sweep was
repeated after the fixes: zero page-level horizontal overflow and no
reproduction of the unintended card spill detected by the same geometry
checks. Dense table and calendar scrolling remains local. Step 5 is a
separate pass, not a conformance claim.

## Design rules

- Put spending and its date/account scope first; put comparisons and details
  underneath. Keep the collection/export controls distinct from the analysis.
- Prefer aligned chart positions and bar lengths for quantitative comparison.
  Keep labels, units and date ranges clear; don't rely on color or hover alone.
- Keep currency, dates, counts, status and actions intact. For abbreviated
  product names, offer a way to read the full text with keyboard and touch as
  well as mouse. Let prose and labels wrap rather than assume it always fits.
- At a 320 CSS px viewport, the **page** should reflow without horizontal
  scrolling. A genuine table or calendar can scroll inside its own bounded,
  discoverable region. Its title, search, filters and other adjacent controls
  should still fit.
- Check focus against the sticky header, navigation, rail and overlays. Don't
  use page-level `overflow-x: hidden` to conceal an overflow bug.

## Regression checklist

| Area | What to test |
| --- | --- |
| Layout | 1920 and 1440 px; just above/below the 1420 and 1100 px shell breakpoints and the view-specific breakpoints; 768, 390 and 320 px; short/wide windows and classic scrollbars. Resize while each view is open. |
| Magnification | Actual browser zoom at 200% and 400%; separately check text resizing to 200% and spacing of 1.5× line height, 2× paragraph spacing, 0.12em letter spacing and 0.16em word spacing. |
| Data stress | Zero, negative, missing and very large currency values; wide currency symbols/grouping; long labels with and without spaces, diacritics and right-to-left text; long account names with the provider selector visible; sparse vs. dense history and one vs. many months. |
| State coverage | Empty/loading/populated; no search matches; summary-only and saved invoices; expanded invoice/item/category; selected range/month; account switch/rename; long banners and dialogs; side panel in list and settings modes. |
| Component bounds | Measure page overflow, text bounds against clipping ancestors, and card/control bounds. Verify numbers render in full at readable sizes. Visually inspect screenshots too: geometric tests don't see what is painted inside a chart canvas. |
| Scrolling and input | Reach the last column and row of wide tables/calendar by keyboard, trackpad and touch. Tab through sticky areas and confirm focus remains visible. Check chart tooltip placement at all edges, legends, labels and the selected month. |
| Visual quality | Light/dark; text and control contrast; reduced motion and forced colors; consistent gutters, card alignment and hierarchy. Test meaning without color. |
| Browser coverage | Run the same fixtures in Chromium and Firefox. Check representative real browser zoom and at least one Windows setup with non-overlay scrollbars. |

References: [W3C Reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html),
[Text Spacing](https://www.w3.org/WAI/WCAG22/Understanding/text-spacing.html),
[Focus Not Obscured](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html),
[Microsoft dashboard design tips](https://learn.microsoft.com/en-us/power-bi/create-reports/service-dashboards-design-tips),
and [Nielsen Norman Group on dashboard charts](https://www.nngroup.com/articles/dashboards-preattentive/).
