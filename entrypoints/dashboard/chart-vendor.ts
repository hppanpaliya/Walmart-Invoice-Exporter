/**
 * Chart.js vendor module for the dashboard (the first Vite-bundled code in
 * the strangler migration). The dashboard's page logic is still a classic
 * script (public/dashboard.page.js), so the interface is deliberately dumb:
 * expose the Chart constructor as window.Chart and announce readiness.
 * dashboard.page.js checks window.Chart defensively — if this module ever
 * fails to load, the CSS-bar chart fallback still renders.
 *
 * Module scripts are deferred, so this runs AFTER the classic scripts; the
 * wie-chart-ready event lets an already-painted page upgrade its chart.
 */
import Chart from 'chart.js/auto';

(window as unknown as { Chart: typeof Chart }).Chart = Chart;
window.dispatchEvent(new Event('wie-chart-ready'));
