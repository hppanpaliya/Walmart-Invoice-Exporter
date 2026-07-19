# Featured-badge nomination draft

> Where: `support.google.com/chrome_webstore/contact/one_stop_support`
> ("Chrome Web Store One Stop Support"). Submit ONLY after v8.0 is live and
> the new screenshots + description are up — reviewers judge the live
> listing. Prerequisites checklist is in README.md. One submission per
> extension per 6-month window.

## Page 1 — publisher & eligibility

| Field | Answer |
|---|---|
| Publisher email address | `panpaliyah@gmail.com` |
| Extension ID | `bndkihecbbkoligeekekdgommmdllfpe` |
| Do you own a domain related to this extension? If yes, provide the site URL. | Leave blank unless a site is verified in the CWS developer dashboard (GitHub repo/Pages URL). Not required for the Featured badge — only gates the separate Established Publisher badge. |
| Confirm that your extension is published to all public users. | Yes |
| Confirm that your extension is relevant to a broad set of users. | Yes |
| Is this publisher account clear from any active violations on the Chrome Web Store or other Google services? | Yes |

## Page 1 — best-practices checkboxes (select all)

Check every box in both groups below — that's what the README's publish
checklist exists to guarantee before nomination:

**"Confirm that your extension meets our extension development best
practices"**
- [x] Compliance — complies with store program policies
- [x] Manifest V3
- [x] Security — no threats, no deceptive install tactics
- [x] User privacy — handles data appropriately, conforms to CWS data
      privacy requirements
- [x] Performance — well optimized, minimal system resources
- [x] User experience — pleasing, intuitive, respects user control over
      settings/privacy
- [x] Clear and accurate store listing — expectations set correctly, all
      image assets (icon, tile, marquee, screenshots) provided and on-brand,
      privacy info accurate and up to date

**"Confirm that your extension's listing page lists all the main
functionalities provided."** → Yes

**"Confirm that your extension's listing page follows our best practices"**
- [x] Summary is concise, highlights features that resonate with the
      audience's main use cases
- [x] Description is focused on keywords representing the most important
      features
- [x] Images are simple, colors/design consistent with other asset branding
- [x] Screenshots are clear, correctly sized, convey capability and UX

## Page 2 — free-text questions

### What is the purpose of your extension? Describe the value it provides to Chrome users.

Walmart Invoice Exporter turns a Walmart customer's order history into a
private spending dashboard and usable documents. The dashboard shows monthly
spend on an interactive chart (click a month to drill in), lets users expand
any order into its complete invoice inline — items, prices, full money
breakdown, payment methods — and surfaces insights like biggest order,
savings rate, busiest day, and price changes on repurchased items. From the
same data, users export Excel workbooks, CSV (including QuickBooks/Xero
presets), JSON, PDF invoices, and printable receipts. It solves a real gap:
walmart.com offers no bulk export or spending overview, so anyone doing
taxes, expense reports, or budgeting must open orders one by one.

### How should your extension be used? Provide examples of main use cases.

1. A small-business owner exports Q1–Q4 Walmart orders into one Excel
   workbook as supporting documents for tax filing.
2. A family tracks grocery inflation: the dashboard's Price Watch shows which
   staples got more expensive since their first purchase, and the insights
   card shows savings rate and their most-bought item.
3. A user reconciles HSA/FSA or reimbursable purchases by collecting with
   Walmart's own filters (order type + date range), clicking the relevant
   month on the dashboard chart, and exporting exactly that scope.
4. A couple sharing one browser keeps their Walmart accounts separate: each
   account's orders, totals, and exports stay scoped to that account.
5. A power user exports JSON/CSV and feeds it to a spreadsheet or AI
   assistant for personalized budget analysis.

### Specify any access to other products, platforms or restricted sites your extension requires to satisfy its purpose (i.e. Netflix account, Adobe creative suite account, banking, internal domains etc.)

None beyond the Walmart account the user is already logged into on
walmart.com (and walmart.ca as an optional, explicitly-granted permission).
No third-party accounts, no restricted-site access, no external servers —
all processing is local to the browser.

## Technical best practices (mention if the form asks elsewhere, e.g. support chat)

- Manifest V3; side panel API; no remotely hosted code — all libraries
  (including Chart.js for the dashboard) bundled.
- Least privilege: host access limited to walmart.com order pages, with
  walmart.ca as an optional permission the user grants explicitly; no new
  permissions for the dashboard page.
- All parsing, charting, and file generation is local; the extension never
  calls external servers. Multi-account detection stores only a hash.
- Respects user privacy by architecture, not just policy: no data collection
  is declared in the privacy tab and the code is publicly auditable.
- Automated quality: a unit-test suite (node:test + Vitest) and a Playwright
  end-to-end suite that drives the real packaged extension, including
  download verification, on every push.
- Accessible, polished UI: one design language in light and dark across
  panel, settings, and dashboard; keyboard-navigable views; ARIA live
  regions for progress; reduced-motion support.
