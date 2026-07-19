/**
 * Reusable vanilla UI components (design spec §5.5).
 *
 * Small factory functions, no framework/build step (locked decision — see
 * docs/superpowers/specs/2026-07-14-panel-redesign-and-storage-unification-
 * design.md §5.5). Loaded via a plain <script> tag after utils.js (for
 * renderIcon/escapeHtml) and sidepanel.state.js, before sidepanel.view.js —
 * view.js's notice functions (showExtractionWarning, updateFilterNotice)
 * render through Banner() here instead of several separate hand-rolled
 * notice styles.
 *
 * Every factory returns a plain DOM element (or, where there's genuine
 * ongoing state to manage, a small object wrapping one) — callers wire up
 * their own event listeners exactly as the rest of this codebase already
 * does (e.g. `banner.querySelector('#someLink').addEventListener(...)`).
 * No caller-facing state machine, no re-render diffing — matches the
 * existing innerHTML-template style used throughout sidepanel.view.js.
 */
(() => {
  const Sidepanel = window.Sidepanel || (window.Sidepanel = {});

  // Panel-owned styles for the multi-provider chrome: the header's
  // always-visible provider dropdown (#providerSelect, sidepanel.html) and
  // the per-row provider tag shown in the combined "All providers" view
  // (sidepanel.view.js). Injected here rather than added to sidepanel.css so
  // the provider UI ships as one self-contained unit with the components/view
  // code that renders it. Idempotent and best-effort — a missing head (or a
  // test sandbox's fake DOM) must never break the panel.
  (function injectProviderChromeStyles() {
    if (!document.head || document.getElementById("providerChromeStyles")) return;
    const style = document.createElement("style");
    style.id = "providerChromeStyles";
    style.textContent = `
      .provider-select {
        max-width: 130px;
        padding: 3px 6px;
        font-size: 11px;
        border: 1px solid var(--border, rgba(128, 128, 128, 0.35));
        border-radius: 6px;
        background: var(--surface, transparent);
        color: inherit;
      }
      .order-provider-tag {
        display: inline-block;
        margin-left: 6px;
        padding: 0 5px;
        border-radius: 8px;
        font-size: 9px;
        line-height: 14px;
        background: var(--surface-2, rgba(128, 128, 128, 0.15));
        color: var(--text-muted, inherit);
        vertical-align: 1px;
        white-space: nowrap;
      }
    `;
    document.head.appendChild(style);
  })();

  const BANNER_ICONS = {
    info: { icon: "INFO_CIRCLE", color: "var(--accent)" },
    success: { icon: "SUCCESS_CHECKMARK", color: "var(--success-fg)" },
    warning: { icon: "ERROR_CIRCLE", color: "var(--warning-fg)" },
    danger: { icon: "ERROR_CIRCLE", color: "var(--danger-fg)" },
  };

  /** role="alert" interrupts (warning/danger); role="status" is polite (info/success). */
  const BANNER_ROLES = {
    info: "status",
    success: "status",
    warning: "alert",
    danger: "alert",
  };

  /**
   * An accessible notice banner. Replaces the five/six previously-separate
   * ad-hoc notice styles (off-tab warning, extraction warning, filter
   * notice, cache-info, db-stats, rating hint) with one component.
   *
   * @param {Object} options
   * @param {'info'|'warning'|'danger'|'success'} [options.variant='info']
   * @param {string} options.message - HTML content for the banner body.
   *   Treated as trusted markup (matches the existing notice functions this
   *   replaces, which already interpolate raw HTML like inline <a> links)
   *   — callers must escapeHtml() any dynamic/user-influenced text
   *   themselves before interpolating, exactly as they do today.
   * @param {boolean} [options.dismissible=false] - Show a dismiss (X) button.
   * @param {Function} [options.onDismiss] - Called just before the banner
   *   removes itself from the DOM via the dismiss button.
   * @param {string} [options.actionHtml] - Optional trailing HTML (a link,
   *   a button) rendered below the message, e.g. "Return to Walmart
   *   Orders" or a destructive "clear" action.
   * @param {string} [options.id] - Optional id set on the root element.
   * @returns {HTMLElement}
   */
  function Banner({ variant = "info", message = "", dismissible = false, onDismiss, actionHtml = "", id } = {}) {
    const iconSpec = BANNER_ICONS[variant] || BANNER_ICONS.info;
    const role = BANNER_ROLES[variant] || "status";

    const el = document.createElement("div");
    if (id) el.id = id;
    el.className = `banner banner-${variant}`;
    el.setAttribute("role", role);
    if (role === "status") el.setAttribute("aria-live", "polite");

    const iconSpan = document.createElement("span");
    iconSpan.className = "banner-icon";
    iconSpan.innerHTML = renderIcon(iconSpec.icon, iconSpec.color);
    el.appendChild(iconSpan);

    const body = document.createElement("div");
    body.className = "banner-body";
    body.innerHTML = message || "";
    if (actionHtml) {
      const action = document.createElement("div");
      action.className = "banner-action";
      action.innerHTML = actionHtml;
      body.appendChild(action);
    }
    el.appendChild(body);

    if (dismissible) {
      const dismissButton = document.createElement("button");
      dismissButton.type = "button";
      dismissButton.className = "banner-dismiss";
      dismissButton.setAttribute("aria-label", "Dismiss");
      dismissButton.innerHTML = renderIcon("X_CLOSE");
      dismissButton.addEventListener("click", () => {
        if (typeof onDismiss === "function") onDismiss();
        el.remove();
      });
      el.appendChild(dismissButton);
    }

    return el;
  }

  /**
   * A persistent aria-live="polite" region for progress/status text.
   * Callers set `.textContent`/`.innerHTML` directly (same idiom as the
   * existing #progress/#downloadProgress elements) — this just returns a
   * correctly-labeled, correctly-styled element to hold that text.
   * @param {string} [initialText='']
   * @returns {HTMLElement}
   */
  function StatusLine(initialText = "") {
    const el = document.createElement("div");
    el.className = "status-line";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    el.textContent = initialText;
    el.hidden = !initialText;
    return el;
  }

  /**
   * A determinate progress bar. The returned element exposes `.update(
   * current, total)` so a caller can reuse the same DOM node across a
   * multi-step operation instead of re-creating it.
   * @param {number} [current=0]
   * @param {number} [total=0]
   * @returns {HTMLElement}
   */
  function ProgressBar(current = 0, total = 0) {
    const el = document.createElement("div");
    el.className = "progress-bar";
    el.setAttribute("role", "progressbar");
    el.setAttribute("aria-valuemin", "0");
    el.setAttribute("aria-valuemax", "100");

    const fill = document.createElement("div");
    fill.className = "progress-bar-fill";
    el.appendChild(fill);

    function update(nextCurrent, nextTotal) {
      const pct = nextTotal > 0 ? Math.min(100, Math.max(0, Math.round((nextCurrent / nextTotal) * 100))) : 0;
      fill.style.width = `${pct}%`;
      el.setAttribute("aria-valuenow", String(pct));
      el.setAttribute("aria-label", `${nextCurrent} of ${nextTotal}`);
    }

    update(current, total);
    el.update = update;
    return el;
  }

  /**
   * A focus-trapped modal dialog. Esc and the overlay/cancel button close
   * it as a cancel; the confirm button closes it and invokes onConfirm.
   * Focus moves into the dialog on open and is restored to whatever had
   * focus beforehand on close (WCAG focus-trap requirements — a half-built
   * modal is worse than the native confirm() it is meant to replace).
   *
   * Not wired to any call site yet in this phase (window.confirm() call
   * sites — db-stats clear, dashboard reset — are left alone per the
   * design spec; a later phase migrates them to this component).
   *
   * @param {Object} options
   * @param {string} [options.title]
   * @param {string} [options.bodyHtml]
   * @param {string} [options.confirmLabel='Confirm']
   * @param {'primary'|'danger'} [options.confirmVariant='primary']
   * @param {string} [options.cancelLabel='Cancel']
   * @param {Function} [options.onConfirm]
   * @param {Function} [options.onCancel]
   * @returns {{element: HTMLElement, close: Function}}
   */
  function Dialog({
    title = "",
    bodyHtml = "",
    confirmLabel = "Confirm",
    confirmVariant = "primary",
    cancelLabel = "Cancel",
    onConfirm,
    onCancel,
  } = {}) {
    const opener = document.activeElement;

    const overlay = document.createElement("div");
    overlay.className = "dialog-overlay";

    const dialog = document.createElement("div");
    dialog.className = "dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.tabIndex = -1;
    if (title) dialog.setAttribute("aria-label", title);

    const confirmBtnClass = confirmVariant === "danger" ? "btn-danger" : "btn-primary";
    dialog.innerHTML = `
      ${title ? `<h3 class="dialog-title">${escapeHtml(title)}</h3>` : ""}
      <div class="dialog-body">${bodyHtml}</div>
      <div class="dialog-actions">
        <button type="button" class="btn btn-clear dialog-cancel">${escapeHtml(cancelLabel)}</button>
        <button type="button" class="btn ${confirmBtnClass} dialog-confirm">${escapeHtml(confirmLabel)}</button>
      </div>
    `;
    overlay.appendChild(dialog);

    function getFocusable() {
      return Array.from(
        dialog.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
      ).filter((node) => !node.disabled);
    }

    function focusElement(node) {
      if (node && typeof node.focus === "function") node.focus();
    }

    let closed = false;
    function close(result) {
      if (closed) return;
      closed = true;
      document.removeEventListener("keydown", onKeydown, true);
      overlay.remove();
      focusElement(opener);
      if (result === "confirm" && typeof onConfirm === "function") onConfirm();
      if (result === "cancel" && typeof onCancel === "function") onCancel();
    }

    function onKeydown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        close("cancel");
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = getFocusable();
      if (focusable.length === 0) {
        event.preventDefault();
        focusElement(dialog);
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        focusElement(last);
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        focusElement(first);
      }
    }

    dialog.querySelector(".dialog-cancel").addEventListener("click", () => close("cancel"));
    dialog.querySelector(".dialog-confirm").addEventListener("click", () => close("confirm"));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close("cancel");
    });

    document.body.appendChild(overlay);
    document.addEventListener("keydown", onKeydown, true);
    focusElement(getFocusable()[0] || dialog);

    return { element: overlay, close };
  }

  /**
   * A transient confirmation toast. Reuses the existing #toast element's
   * styling/behavior (sidepanel.html/.css) rather than creating a new node
   * per call — same fixed "inverse" surface, same show/hide transition.
   * @param {string} [message] - When provided, replaces the toast's text.
   * @param {Object} [options]
   * @param {number} [options.durationMs=2000]
   * @returns {HTMLElement|null} the #toast element, or null if absent.
   */
  function Toast(message, { durationMs = 2000 } = {}) {
    const toast = document.getElementById("toast");
    if (!toast) return null;

    if (message) {
      const textEl = toast.querySelector("span");
      if (textEl) textEl.textContent = message;
    }

    toast.classList.add("show");
    clearTimeout(toast._hideTimer);
    toast._hideTimer = setTimeout(() => {
      toast.classList.remove("show");
    }, durationMs);

    return toast;
  }

  Sidepanel.components = {
    Banner,
    StatusLine,
    ProgressBar,
    Dialog,
    Toast,
  };
})();
