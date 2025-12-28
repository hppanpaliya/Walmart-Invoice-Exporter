# UI/UX Design System

Local development reference for the Walmart Invoice Exporter Chrome extension.

---

## Design Tokens (CSS Variables)

```css
:root {
  --primary: #0071dc;       /* Walmart blue - primary actions, links */
  --danger: #e41e31;        /* Red - destructive actions, errors */
  --success: #2ecc71;       /* Green - success states, download buttons */
  --background: #f8f9fa;    /* Light gray - card backgrounds, inputs */
  --border: #e5e7eb;        /* Border color for cards, inputs, dividers */
  --text: #1a1a1a;          /* Primary text color */
  --text-secondary: #666;   /* Secondary/muted text */
}
```

---

## Typography

- **Font Stack**: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`
- **Base Size**: 12px (popup), 14px (FAQ/docs)
- **Line Height**: 1.6 (for readability in FAQ)

| Element | Size | Weight | Color |
|---------|------|--------|-------|
| Popup H1 | 16px | 600 | --text |
| FAQ H1 | 24-32px | 600 | --text |
| Section H3 | 14px | normal | --text |
| Body text | 12px | normal | --text |
| Labels | 12px | normal | --text-secondary |
| Cache info | 11px | normal | --text-secondary |
| Timestamps | 10px | italic | --text-secondary |

---

## Layout

### Popup Window
- **Width**: 400px (fixed)
- **Padding**: 10px
- **Background**: white

### Structure
```
┌─────────────────────────────────────┐
│ [Icon] Title              [FAQ btn] │  ← Header
├─────────────────────────────────────┤
│ ┌─────────────────────────────────┐ │
│ │ Page limit input                │ │  ← Card (settings)
│ │ Export mode dropdown            │ │
│ │ [Start] [Stop] [Clear]          │ │
│ └─────────────────────────────────┘ │
├─────────────────────────────────────┤
│ Progress message                    │  ← Progress area
├─────────────────────────────────────┤
│ Select orders (N) - Selected: X     │  ← Order list header
│ ☑ Select All                        │
│ ┌─────────────────────────────────┐ │
│ │ ☐ Order #12345 ⓘ               │ │  ← Scrollable list
│ │ ☐ Order #67890 ⓘ               │ │     (max-height: 150px)
│ └─────────────────────────────────┘ │
│ [Download Selected Orders]          │  ← Action button
└─────────────────────────────────────┘
```

---

## Components

### Card
```css
.card {
  background: var(--background);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 12px;
}
```

### Buttons

| Class | Background | Text | Use Case |
|-------|------------|------|----------|
| `.btn-primary` | --primary | white | Start Collection |
| `.btn-danger` | --danger | white | Stop Collection |
| `.btn-success` | --success | white | Download actions |
| `.btn-clear` | --background | --text-secondary | Clear Cache |

**Button Styling:**
```css
.btn {
  padding: 8px 16px;
  border: none;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  gap: 6px;
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
```

### Input Fields
```css
.input-group input,
.input-group select {
  padding: 6px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 12px;
}

/* Focus state */
input:focus {
  outline: none;
  border-color: var(--primary);
  box-shadow: 0 0 0 2px rgba(0, 113, 220, 0.1);
}
```

### Checkbox Container
```css
.checkbox-container {
  padding: 8px 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.checkbox-container input[type="checkbox"] {
  width: 14px;
  height: 14px;
  cursor: pointer;
}
```

### Loading Spinner
```css
.loading-spinner {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 2px solid #ffffff;
  border-radius: 50%;
  border-top-color: transparent;
  animation: spin 0.8s linear infinite;
}
```

### Tooltips
```css
.order-tooltip {
  background-color: #333;
  color: white;
  padding: 5px 8px;
  border-radius: 4px;
  font-size: 11px;
  position: absolute;
  z-index: 1;
  /* Arrow pointing up */
}
```

### Progress/Status Messages
```css
#progress {
  font-size: 12px;
  color: var(--text-secondary);
  padding: 6px;
  background: var(--background);
  border-radius: 6px;
  border: 1px solid var(--border);
}
```

### Cache Info Banner
```css
.cache-info {
  font-size: 11px;
  color: var(--text-secondary);
  padding: 4px 8px;
  background: #f0f9ff;  /* Light blue tint */
  border-radius: 4px;
}
```

### Notes/Warnings (FAQ)
```css
.note {
  background: #fff3cd;
  border: 1px solid #ffeeba;
  color: #856404;
  padding: 12px;
  border-radius: 4px;
}
```

---

## Icons

All icons are inline SVG with:
- `stroke="currentColor"` for color inheritance
- `stroke-width="2"` standard weight
- Common sizes: 16px, 24px, 32px

**Icon Library** (defined in `utils.js` as `ICONS`):
- CART - Shopping cart (header)
- TRASH - Delete/clear cache
- CHECK - Success states
- DOWNLOAD - Download actions
- QUESTION - FAQ/help button
- STAR - Rating prompt
- CLOSE - Dismiss buttons
- LINK - External links
- ERROR_LARGE - Error states

---

## Animations & Transitions

### Standard Transition
```css
transition: all 0.2s ease;
```

### FAQ Accordion
```css
.faq-answer {
  max-height: 0;
  overflow: hidden;
  transition: max-height 0.3s ease-out, padding 0.3s ease-out;
}

.faq-answer.active {
  max-height: 900px;
}
```

### Rating Hint Slide-in
```css
.rating-hint {
  opacity: 0;
  max-height: 0;
  transition: opacity 0.3s, max-height 0.3s;
}

.rating-hint.show {
  opacity: 1;
  max-height: 40px;
}
```

---

## Scrollbars (Custom)

```css
::-webkit-scrollbar {
  width: 4px;
}

::-webkit-scrollbar-track {
  background: var(--background);
  border-radius: 4px;
}

::-webkit-scrollbar-thumb {
  background: #ccc;
  border-radius: 4px;
}

::-webkit-scrollbar-thumb:hover {
  background: #999;
}
```

---

## Responsive Behavior

- **Popup**: Fixed 400px width (Chrome extension constraint)
- **FAQ Page**: Max-width 800px, centered, 20px padding
- **Order List**: Scrollable at max-height 150px

---

## State Patterns

### Button Loading State
1. Disable button (`disabled = true`)
2. Insert `.loading-spinner` before button text
3. On complete: remove spinner, enable button

### Collection Progress
1. Hide Start button, show Stop button
2. Display animated progress with spinner
3. Disable all checkboxes during collection
4. Re-enable on completion

### Cache Indicators
- Cached orders show special styling
- Cache info banner displays order count and timestamp
- Individual clear cache buttons per order

---

## Accessibility Notes

- All interactive elements have `cursor: pointer`
- Focus states use visible outlines with `--primary` color
- Disabled states use `opacity: 0.6`
- Labels are associated with inputs via `htmlFor`
- Tooltips have sufficient contrast (#333 bg, white text)
