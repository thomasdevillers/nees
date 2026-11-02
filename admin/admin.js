const app = document.querySelector("#app");
const signoutButton = document.querySelector("[data-signout]");

/* ---------- helpers ---------- */

class RequestError extends Error { constructor(message, status) { super(message); this.status = status; } }
async function api(path, init = {}) {
  const response = await fetch(`/api/admin/${path}`, { ...init, cache: "no-store", headers: { "Content-Type": "application/json", ...init.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new RequestError(body.error || "Something went wrong. Please try again.", response.status);
  return body;
}

// Builds DOM nodes without innerHTML so stored text is never interpreted as markup.
function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (key in node && typeof value !== "string") node[key] = value;
    else node.setAttribute(key, value === true ? "" : value);
  }
  node.append(...children.flat(Infinity).filter(child => child != null && child !== false));
  return node;
}

const DAY_MS = 86_400_000;
const pad = value => String(value).padStart(2, "0");
const ymd = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const parse = value => new Date(`${value}T00:00:00`);
const addDays = (value, days) => { const date = parse(value); date.setDate(date.getDate() + days); return ymd(date); };
const utc = value => Date.parse(`${value}T00:00:00Z`);
const daysBetween = (start, end) => (utc(end) - utc(start)) / DAY_MS + 1;
const today = () => ymd(new Date());
const fmt = (value, options) => new Intl.DateTimeFormat("en-GB", options).format(parse(value));
const shortDate = value => fmt(value, { weekday: "short", day: "numeric", month: "short" });
const longDate = value => fmt(value, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
function dateRange(start, end) {
  if (start === end) return longDate(start);
  const sameYear = start.slice(0, 4) === end.slice(0, 4);
  return `${sameYear ? shortDate(start) : longDate(start)} – ${longDate(end)}`;
}
const plural = (count, word, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;

/* ---------- state ---------- */

const remembered = (() => { try { return JSON.parse(localStorage.getItem("onscene-admin-view") || "{}"); } catch { return {}; } })();
const state = {
  auth: null, error: "", loading: false, screens: [], clients: [], rentals: [],
  tab: ["screens", "clients"].includes(remembered.tab) ? remembered.tab : "rentals",
  view: remembered.view === "list" ? "list" : "calendar",
  month: today().slice(0, 7), selected: today(), filter: "", scope: "upcoming", rentalSearch: "", screenSearch: "", clientSearch: "",
};
function remember() { try { localStorage.setItem("onscene-admin-view", JSON.stringify({ tab: state.tab, view: state.view })); } catch { /* storage unavailable */ } }
function set(changes) { Object.assign(state, changes); remember(); render(); }

const screenById = id => state.screens.find(screen => screen.id === id);
const numberOf = id => screenById(id)?.number ?? "?";
const clientById = id => state.clients.find(client => client.id === id);
const clientName = id => clientById(id)?.name ?? "Unknown client";
const rentalsOn = (day, rentals = state.rentals) => rentals.filter(rental => rental.start <= day && day <= rental.end);
const visibleRentals = () => state.filter ? state.rentals.filter(rental => rental.screenIds.includes(state.filter)) : state.rentals;
const sortedScreenIds = ids => [...ids].sort((a, b) => numberOf(a).localeCompare(numberOf(b), "en", { numeric: true }));

function expire() { state.auth = false; state.error = "Your session has ended. Sign in again to continue."; render(); }
function handleError(error, fallback) {
  if (error instanceof RequestError && error.status === 401) { expire(); return null; }
  return error instanceof Error ? error.message : fallback;
}

async function load() {
  state.loading = true; state.error = ""; render();
  try {
    const [{ screens }, { clients }, { rentals }] = await Promise.all([api("screens"), api("clients"), api("rentals")]);
    Object.assign(state, { screens, clients, rentals });
    if (state.filter && !screenById(state.filter)) state.filter = "";
  } catch (error) { state.error = handleError(error, "Could not load the back office.") ?? ""; }
  finally { state.loading = false; render(); }
}

/* ---------- login ---------- */

function loginView() {
  let busy = false;
  const input = h("input", { id: "admin-password", type: "password", autocomplete: "current-password", required: true });
  const button = h("button", { class: "button primary wide", type: "submit" }, h("span", {}, "Open the back office"), h("span", { "aria-hidden": "true" }, "↗"));
  const message = h("p", { class: "error", role: "alert", hidden: !state.error }, state.error);
  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    busy = true; button.disabled = true; button.firstChild.textContent = "Signing in…"; message.hidden = true;
    try {
      await api("session", { method: "POST", body: JSON.stringify({ password: input.value }) });
      state.auth = true; state.error = ""; render(); void load();
    } catch (error) {
      message.textContent = error.message; message.hidden = false;
      busy = false; button.disabled = false; button.firstChild.textContent = "Open the back office";
    }
  }
  return h("section", { class: "login" },
    h("div", { class: "login-glow", "aria-hidden": "true" }),
    h("p", { class: "eyebrow dot" }, "OnScene — Team access"),
    h("h1", {}, "Every screen.", h("br"), h("span", {}, "On schedule.")),
    h("p", { class: "lede" }, "Sign in to manage the screen fleet and keep track of who has which screens, and when."),
    h("form", { onsubmit: submit }, h("label", { for: "admin-password" }, "Admin password"), input, button),
    message);
}

/* ---------- dashboard ---------- */

function heading() {
  const day = today();
  const active = state.screens.filter(screen => screen.status !== "retired");
  const out = new Set(rentalsOn(day).flatMap(rental => rental.screenIds));
  const free = active.filter(screen => screen.status === "available" && !out.has(screen.id));
  const copy = {
    rentals: { eyebrow: "OnScene / Rentals", title: "Rental days", text: "Who has which screens, and when. Add bookings as they're confirmed." },
    screens: { eyebrow: "OnScene / Fleet", title: "The screens", text: "Every display, tracked by the number on its frame." },
    clients: { eyebrow: "OnScene / Clients", title: "The clients", text: "Who you rent to, how to reach them, and where the screens go by default." },
  }[state.tab];
  return h("section", { class: "heading" },
    h("div", {}, h("p", { class: "eyebrow dot" }, copy.eyebrow), h("h1", {}, copy.title, h("span", { class: "accent" }, ".")), h("p", { class: "lede" }, copy.text)),
    h("dl", { class: "stats" },
      h("div", {}, h("dt", {}, "Fleet"), h("dd", {}, active.length)),
      h("div", {}, h("dt", {}, "Out today"), h("dd", {}, out.size)),
      h("div", { class: "lime" }, h("dt", {}, "Free today"), h("dd", {}, free.length))));
}

function tabs() {
  const tab = (id, label, count) => h("button", { type: "button", role: "tab", "aria-selected": String(state.tab === id), onclick: () => set({ tab: id }) }, label, h("span", { class: "count" }, count));
  return h("nav", { class: "tabs", role: "tablist", "aria-label": "Admin sections" },
    tab("rentals", "Rental days", state.rentals.length), tab("screens", "Screens", state.screens.length), tab("clients", "Clients", state.clients.length));
}

function segmented(label, value, options, onchange) {
  return h("div", { class: "segmented", role: "group", "aria-label": label },
    options.map(([id, text]) => h("button", { type: "button", "aria-pressed": String(value === id), onclick: () => onchange(id) }, text)));
}

function screenFilter() {
  return h("label", { class: "field inline" }, h("span", {}, "Screen"),
    h("select", { onchange: event => set({ filter: event.target.value }) },
      h("option", { value: "" }, "All screens"),
      state.screens.map(screen => h("option", { value: screen.id, selected: screen.id === state.filter }, `#${screen.number}${screen.label ? ` · ${screen.label}` : ""}`))));
}

function rentalChip(rental, day) {
  const classes = ["chip", day && rental.start < day && "continues", day && rental.end > day && "carries"].filter(Boolean).join(" ");
  const numbers = sortedScreenIds(rental.screenIds).map(id => `#${numberOf(id)}`).join(" ");
  return h("button", { type: "button", class: classes, title: `${clientName(rental.clientId)} · ${numbers} · ${dateRange(rental.start, rental.end)}`, onclick: event => { event.stopPropagation(); rentalDialog(rental); } },
    h("span", { class: "chip-screens" }, sortedScreenIds(rental.screenIds).map(id => h("b", {}, `#${numberOf(id)}`))),
    h("span", { class: "chip-client" }, clientName(rental.clientId)),
    rental.address ? h("span", { class: "chip-address" }, rental.address) : null);
}

function calendar() {
  const [year, month] = state.month.split("-").map(Number);
  const first = `${state.month}-01`;
  const offset = (parse(first).getDay() + 6) % 7;
  const length = new Date(year, month, 0).getDate();
  const weeks = Math.ceil((offset + length) / 7);
  const rentals = visibleRentals();
  const now = today();
  const cells = Array.from({ length: weeks * 7 }, (_, index) => {
    const day = addDays(first, index - offset);
    const booked = rentalsOn(day, rentals);
    const outside = !day.startsWith(state.month);
    const classes = ["day", outside && "outside", day === now && "today", day === state.selected && "selected", booked.length && "booked"].filter(Boolean).join(" ");
    return h("div", { class: classes, onclick: () => set({ selected: day }) },
      h("button", { type: "button", class: "date", "aria-label": `${longDate(day)}, ${plural(booked.length, "rental")}`, "aria-pressed": String(day === state.selected), onclick: event => { event.stopPropagation(); set({ selected: day }); } }, parse(day).getDate()),
      booked.length ? h("span", { class: "dots", "aria-hidden": "true" }, plural(new Set(booked.flatMap(rental => rental.screenIds)).size, "screen")) : null,
      h("div", { class: "chips" }, booked.slice(0, 3).map(rental => rentalChip(rental, day)), booked.length > 3 ? h("span", { class: "more" }, `+${booked.length - 3} more`) : null));
  });
  const shift = delta => { const date = new Date(year, month - 1 + delta, 1); set({ month: ymd(date).slice(0, 7) }); };
  return h("section", { class: "calendar-wrap", "aria-label": "Rental calendar" },
    h("div", { class: "month-bar" },
      h("button", { type: "button", class: "icon-button", "aria-label": "Previous month", onclick: () => shift(-1) }, "←"),
      h("h2", {}, fmt(first, { month: "long", year: "numeric" })),
      h("button", { type: "button", class: "icon-button", "aria-label": "Next month", onclick: () => shift(1) }, "→"),
      h("button", { type: "button", class: "button ghost small", onclick: () => set({ month: now.slice(0, 7), selected: now }) }, "Today")),
    h("div", { class: "calendar" },
      ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(name => h("div", { class: "weekday", "aria-hidden": "true" }, name)),
      cells),
    h("p", { class: "hint" }, "Select a day to see who has which screens and what is still free."),
    dayPanel());
}

function dayPanel() {
  const day = state.selected;
  const booked = rentalsOn(day, visibleRentals());
  const out = new Set(rentalsOn(day).flatMap(rental => rental.screenIds));
  const free = state.screens.filter(screen => screen.status === "available" && !out.has(screen.id));
  return h("section", { class: "day-panel", "aria-label": `Rentals on ${longDate(day)}` },
    h("div", { class: "day-panel-head" },
      h("div", {}, h("p", { class: "eyebrow" }, "Selected day"), h("h3", {}, longDate(day))),
      h("button", { type: "button", class: "button primary small", onclick: () => rentalDialog(null, day) }, "Add rental", h("span", { "aria-hidden": "true" }, "+"))),
    booked.length ? h("ul", { class: "agenda" }, booked.map(rental => h("li", {}, rentalSummary(rental)))) : h("p", { class: "empty" }, state.filter ? `#${numberOf(state.filter)} is free on this day.` : "No screens out on this day."),
    h("div", { class: "free" }, h("p", { class: "eyebrow" }, `Free and available · ${free.length}`),
      free.length ? h("p", { class: "numbers" }, free.map(screen => h("span", {}, `#${screen.number}`))) : h("p", { class: "empty" }, "Every available screen is out.")));
}

function rentalSummary(rental) {
  const days = daysBetween(rental.start, rental.end);
  return h("article", { class: "rental" },
    h("div", { class: "rental-dates" }, h("strong", {}, dateRange(rental.start, rental.end)), h("span", {}, plural(days, "day"))),
    h("div", { class: "rental-main" },
      h("h4", {}, clientName(rental.clientId)),
      rental.address ? h("p", { class: "muted address" }, rental.address) : null,
      contact(clientById(rental.clientId)),
      h("p", { class: "numbers" }, sortedScreenIds(rental.screenIds).map(id => h("button", { type: "button", class: "tag", title: "Show this screen's rentals", onclick: () => set({ tab: "rentals", filter: id }) }, `#${numberOf(id)}`))),
      rental.notes ? h("p", { class: "notes" }, rental.notes) : null),
    h("div", { class: "row-actions" },
      h("button", { type: "button", class: "button ghost small", onclick: () => rentalDialog(rental) }, "Edit"),
      h("button", { type: "button", class: "button danger small", onclick: () => removeRental(rental) }, "Delete")));
}

function rentalList() {
  const now = today();
  const query = state.rentalSearch.trim().toLowerCase();
  let rentals = visibleRentals();
  if (state.scope === "upcoming") rentals = rentals.filter(rental => rental.end >= now);
  if (state.scope === "past") rentals = rentals.filter(rental => rental.end < now).reverse();
  if (query) rentals = rentals.filter(rental => [clientName(rental.clientId), clientById(rental.clientId)?.email, clientById(rental.clientId)?.phone, rental.address, rental.notes, ...rental.screenIds.map(numberOf)].join(" ").toLowerCase().includes(query));
  const search = h("input", { type: "search", placeholder: "Search client, address or screen", value: state.rentalSearch, "aria-label": "Search rentals",
    oninput: event => { state.rentalSearch = event.target.value; const position = event.target.selectionStart; render(); const next = app.querySelector("[aria-label='Search rentals']"); next?.focus(); next?.setSelectionRange(position, position); } });
  return h("section", { class: "list-wrap", "aria-label": "Rental list" },
    h("div", { class: "list-bar" }, segmented("Which rentals", state.scope, [["upcoming", "Current & upcoming"], ["past", "Past"], ["all", "All"]], scope => set({ scope })), search),
    rentals.length ? h("ul", { class: "rental-list" }, rentals.map(rental => {
      const live = rental.start <= now && now <= rental.end;
      return h("li", { class: live ? "live" : "" }, live ? h("span", { class: "live-badge" }, "Out now") : null, rentalSummary(rental));
    })) : h("p", { class: "empty block" }, state.rentals.length ? "No rentals match." : "No rentals yet. Add the first booking to see it here and on the calendar."));
}

function rentalsTab() {
  return h("div", {},
    h("div", { class: "toolbar" },
      segmented("Rental view", state.view, [["calendar", "Calendar"], ["list", "List"]], view => set({ view })),
      screenFilter(),
      h("button", { type: "button", class: "button primary", disabled: !state.screens.length, title: state.screens.length ? null : "Add a screen first", onclick: () => rentalDialog(null, state.view === "calendar" ? state.selected : today()) }, "New rental", h("span", { "aria-hidden": "true" }, "+"))),
    !state.screens.length ? h("p", { class: "notice" }, "Add your screens first — every rental links to screens in the fleet. ", h("button", { type: "button", class: "link", onclick: () => set({ tab: "screens" }) }, "Go to Screens →")) : null,
    state.screens.length && !state.clients.length ? h("p", { class: "notice" }, "Every rental links to a client. Add one from the rental form, or ", h("button", { type: "button", class: "link", onclick: () => set({ tab: "clients" }) }, "go to Clients →")) : null,
    state.view === "calendar" ? calendar() : rentalList());
}

const STATUS_LABELS = { available: "Available", maintenance: "Maintenance", retired: "Retired" };

function screensTab() {
  const now = today();
  const query = state.screenSearch.trim().toLowerCase();
  const screens = state.screens.filter(screen => !query || [screen.number, screen.label, screen.notes].join(" ").toLowerCase().includes(query));
  const search = h("input", { type: "search", placeholder: "Search number, label or notes", value: state.screenSearch, "aria-label": "Search screens",
    oninput: event => { state.screenSearch = event.target.value; const position = event.target.selectionStart; render(); const next = app.querySelector("[aria-label='Search screens']"); next?.focus(); next?.setSelectionRange(position, position); } });
  const rows = screens.map(screen => {
    const own = state.rentals.filter(rental => rental.screenIds.includes(screen.id));
    const current = own.find(rental => rental.start <= now && now <= rental.end);
    const next = own.find(rental => rental.start > now);
    return h("tr", {},
      h("th", { scope: "row" }, h("span", { class: "number" }, `#${screen.number}`)),
      h("td", {}, screen.label || h("span", { class: "muted" }, "—"), screen.notes ? h("p", { class: "notes" }, screen.notes) : null),
      h("td", {}, h("span", { class: `status ${screen.status}` }, STATUS_LABELS[screen.status])),
      h("td", {}, current ? h("span", {}, h("strong", {}, clientName(current.clientId)), h("br"), h("span", { class: "muted" }, `until ${shortDate(current.end)}`)) : h("span", { class: "muted" }, "In storage")),
      h("td", {}, next ? h("span", {}, h("strong", {}, clientName(next.clientId)), h("br"), h("span", { class: "muted" }, dateRange(next.start, next.end))) : h("span", { class: "muted" }, "—")),
      h("td", {}, h("div", { class: "row-actions" },
        h("button", { type: "button", class: "button ghost small", onclick: () => set({ tab: "rentals", view: "calendar", filter: screen.id }) }, "Calendar"),
        h("button", { type: "button", class: "button ghost small", onclick: () => screenDialog(screen) }, "Edit"),
        h("button", { type: "button", class: "button danger small", onclick: () => removeScreen(screen, own.length) }, "Delete"))));
  });
  return h("div", {},
    h("div", { class: "toolbar" }, search, h("button", { type: "button", class: "button primary", onclick: () => screenDialog(null) }, "Add screen", h("span", { "aria-hidden": "true" }, "+"))),
    screens.length ? h("div", { class: "table-wrap" }, h("table", { class: "screens" },
      h("thead", {}, h("tr", {}, ["Number", "Label", "Status", "Right now", "Next rental", ""].map(name => h("th", { scope: "col" }, name)))),
      h("tbody", {}, rows)))
      : h("p", { class: "empty block" }, state.screens.length ? "No screens match." : "No screens yet. Add each display using the number on its frame."));
}

function contact(client) {
  if (!client || (!client.email && !client.phone)) return null;
  return h("p", { class: "contact" },
    client.phone ? h("a", { href: `tel:${client.phone.replace(/[^0-9+]/g, "")}` }, client.phone) : null,
    client.email ? h("a", { href: `mailto:${client.email}` }, client.email) : null);
}

function clientsTab() {
  const now = today();
  const query = state.clientSearch.trim().toLowerCase();
  const clients = state.clients.filter(client => !query || [client.name, client.email, client.phone, client.address].join(" ").toLowerCase().includes(query));
  const search = h("input", { type: "search", placeholder: "Search name, email, cellphone or address", value: state.clientSearch, "aria-label": "Search clients",
    oninput: event => { state.clientSearch = event.target.value; const position = event.target.selectionStart; render(); const next = app.querySelector("[aria-label='Search clients']"); next?.focus(); next?.setSelectionRange(position, position); } });
  const rows = clients.map(client => {
    const own = state.rentals.filter(rental => rental.clientId === client.id);
    const upcoming = own.find(rental => rental.end >= now);
    const out = upcoming && upcoming.start <= now;
    return h("tr", {},
      h("th", { scope: "row" }, h("strong", { class: "client-name" }, client.name)),
      h("td", {}, contact(client) || h("span", { class: "muted" }, "No contact details")),
      h("td", {}, client.address ? h("span", { class: "address" }, client.address) : h("span", { class: "muted" }, "—")),
      h("td", {}, plural(own.length, "rental"), upcoming ? h("span", { class: "muted" }, h("br"), out ? `Out until ${shortDate(upcoming.end)}` : `Next ${shortDate(upcoming.start)}`) : null),
      h("td", {}, h("div", { class: "row-actions" },
        h("button", { type: "button", class: "button ghost small", disabled: !own.length, onclick: () => set({ tab: "rentals", view: "list", scope: "all", filter: "", rentalSearch: client.name }) }, "Rentals"),
        h("button", { type: "button", class: "button ghost small", onclick: () => clientDialog(client) }, "Edit"),
        h("button", { type: "button", class: "button danger small", onclick: () => removeClient(client, own.length) }, "Delete"))));
  });
  return h("div", {},
    h("div", { class: "toolbar" }, search, h("button", { type: "button", class: "button primary", onclick: () => clientDialog(null) }, "Add client", h("span", { "aria-hidden": "true" }, "+"))),
    clients.length ? h("div", { class: "table-wrap" }, h("table", { class: "screens clients" },
      h("thead", {}, h("tr", {}, ["Name", "Contact", "Default address", "Rentals", ""].map(name => h("th", { scope: "col" }, name)))),
      h("tbody", {}, rows)))
      : h("p", { class: "empty block" }, state.clients.length ? "No clients match." : "No clients yet. Add the people and companies you rent to."));
}

function render() {
  signoutButton.hidden = !state.auth;
  if (state.auth === null) return;
  if (!state.auth) { app.replaceChildren(loginView()); return; }
  app.replaceChildren(...[
    heading(), tabs(),
    state.error ? h("p", { class: "error", role: "alert" }, state.error, " ", h("button", { type: "button", class: "link", onclick: () => void load() }, "Try again")) : null,
    state.loading && !state.screens.length ? h("p", { class: "loading", role: "status" }, "Loading the fleet…") : { rentals: rentalsTab, screens: screensTab, clients: clientsTab }[state.tab](),
  ].filter(Boolean));
}

/* ---------- dialogs ---------- */

function dialog(title, body, onsubmit, extra, onsaved) {
  const error = h("p", { class: "error", role: "alert", hidden: true });
  const save = h("button", { type: "submit", class: "button primary" }, "Save", h("span", { "aria-hidden": "true" }, "↗"));
  const node = h("dialog", { class: "sheet", onclose: () => node.remove() },
    h("form", {
      method: "dialog",
      onsubmit: async event => {
        event.preventDefault();
        save.disabled = true; error.hidden = true;
        try { const result = await onsubmit(); node.close(); await load(); onsaved?.(result); }
        catch (caught) { const message = handleError(caught, "Could not save."); if (message === null) node.close(); else { error.textContent = message; error.hidden = false; } }
        finally { save.disabled = false; }
      },
    },
      h("div", { class: "sheet-head" }, h("h2", {}, title), h("button", { type: "button", class: "icon-button", "aria-label": "Close", onclick: () => node.close() }, "×")),
      body, error,
      h("div", { class: "sheet-actions" }, extra, h("button", { type: "button", class: "button ghost", onclick: () => node.close() }, "Cancel"), save)));
  document.body.append(node);
  node.showModal();
  node.querySelector("input, select, textarea")?.focus();
  return node;
}

const field = (label, control, help) => h("label", { class: "field" }, h("span", {}, label), control, help ? h("small", {}, help) : null);

function screenDialog(screen) {
  const number = h("input", { name: "number", required: true, maxlength: "20", pattern: "[A-Za-z0-9][A-Za-z0-9\\-]{0,19}", autocomplete: "off", value: screen?.number || "", style: "text-transform: uppercase" });
  const label = h("input", { name: "label", maxlength: "80", placeholder: "e.g. 55\" foldable poster", value: screen?.label || "" });
  const status = h("select", { name: "status" }, Object.entries(STATUS_LABELS).map(([value, text]) => h("option", { value, selected: (screen?.status || "available") === value }, text)));
  const notes = h("textarea", { name: "notes", rows: "3", maxlength: "1000" }, screen?.notes || "");
  dialog(screen ? `Edit screen #${screen.number}` : "Add a screen",
    h("div", { class: "fields" },
      field("Screen number", number, "The unique number printed on the screen."), field("Label", label), field("Status", status), field("Notes", notes)),
    async () => {
      const body = { number: number.value, label: label.value, status: status.value, notes: notes.value };
      await api("screens", { method: screen ? "PATCH" : "POST", body: JSON.stringify(screen ? { ...body, id: screen.id } : body) });
    });
}

function rentalDialog(rental, day = today()) {
  if (!state.screens.length) { set({ tab: "screens" }); return; }
  const start = h("input", { type: "date", name: "start", required: true, value: rental?.start || day });
  const end = h("input", { type: "date", name: "end", required: true, value: rental?.end || day });
  const clientSelect = h("select", { name: "clientId", required: true });
  const fillClients = selected => clientSelect.replaceChildren(h("option", { value: "" }, state.clients.length ? "Choose a client…" : "No clients yet: add one →"),
    ...state.clients.map(client => h("option", { value: client.id, selected: client.id === selected }, client.phone ? `${client.name} · ${client.phone}` : client.name)));
  fillClients(rental?.clientId);
  const address = h("textarea", { name: "address", rows: "2", maxlength: "300" }, rental?.address || "");
  const addressHint = h("small");
  // The address we filled in from the client, so switching clients only replaces an untouched default.
  let autoAddress = rental ? (rental.address === clientById(rental.clientId)?.address ? rental.address : null) : "";
  function syncAddress(clientChanged) {
    const fallback = clientById(clientSelect.value)?.address || "";
    if (clientChanged && (address.value === autoAddress || !address.value.trim())) { address.value = fallback; autoAddress = fallback; }
    addressHint.textContent = !clientSelect.value ? "Prefilled from the client's default address."
      : address.value.trim() === fallback.trim() ? (fallback ? "The client's default address. Change it for this booking if needed." : "This client has no default address. Add one for this booking.")
      : "Custom address for this booking. The client's default stays the same.";
  }
  clientSelect.addEventListener("change", () => syncAddress(true));
  address.addEventListener("input", () => syncAddress(false));
  syncAddress(false);
  const newClient = h("button", { type: "button", class: "button ghost small", onclick: () => clientDialog(null, created => { fillClients(created.id); syncAddress(true); }) }, "New client", h("span", { "aria-hidden": "true" }, "+"));
  const notes = h("textarea", { name: "notes", rows: "3", maxlength: "1000" }, rental?.notes || "");
  const chosen = new Set(rental?.screenIds || (state.filter ? [state.filter] : []));
  const picker = h("div", { class: "picker" });
  const summary = h("p", { class: "picker-summary" });
  function drawPicker() {
    end.min = start.value;
    const valid = start.value && end.value && end.value >= start.value;
    const others = valid ? state.rentals.filter(other => other.id !== rental?.id && other.start <= end.value && start.value <= other.end) : [];
    picker.replaceChildren(...state.screens.filter(screen => screen.status !== "retired" || chosen.has(screen.id)).map(screen => {
      const clash = others.find(other => other.screenIds.includes(screen.id));
      const box = h("input", { type: "checkbox", value: screen.id, checked: chosen.has(screen.id), disabled: !!clash && !chosen.has(screen.id),
        onchange: event => { if (event.target.checked) chosen.add(screen.id); else chosen.delete(screen.id); drawPicker(); } });
      return h("label", { class: ["pick", clash && "clash", chosen.has(screen.id) && "on"].filter(Boolean).join(" ") }, box,
        h("span", { class: "number" }, `#${screen.number}`),
        h("span", { class: "pick-meta" }, clash ? `Booked · ${clientName(clash.clientId)} (${dateRange(clash.start, clash.end)})` : screen.status === "available" ? screen.label || "Free" : STATUS_LABELS[screen.status]));
    }));
    const days = valid ? daysBetween(start.value, end.value) : 0;
    summary.textContent = valid ? `${plural(chosen.size, "screen")} · ${plural(days, "day")}${chosen.size ? ` · ${chosen.size * days} screen-days` : ""}` : "Choose valid dates.";
  }
  start.addEventListener("change", () => { if (end.value < start.value) end.value = start.value; drawPicker(); });
  end.addEventListener("change", drawPicker);
  drawPicker();
  const remove = rental ? h("button", { type: "button", class: "button danger push", onclick: async () => { node.close(); await removeRental(rental); } }, "Delete rental") : null;
  const node = dialog(rental ? "Edit rental" : "New rental",
    h("div", { class: "fields" },
      h("div", { class: "field" }, h("span", {}, "Client"), h("div", { class: "with-action" }, clientSelect, newClient)),
      h("div", { class: "pair" }, field("First day", start), field("Last day", end)),
      field("Address", address, addressHint),
      h("fieldset", { class: "field" }, h("legend", {}, "Screens"), picker, summary),
      field("Notes", notes)),
    async () => {
      const body = { clientId: clientSelect.value, address: address.value, notes: notes.value, start: start.value, end: end.value, screenIds: [...chosen] };
      await api("rentals", { method: rental ? "PATCH" : "POST", body: JSON.stringify(rental ? { ...body, id: rental.id } : body) });
    }, remove);
}

function clientDialog(client, onsaved) {
  const name = h("input", { name: "name", required: true, maxlength: "120", autocomplete: "off", value: client?.name || "" });
  const email = h("input", { type: "email", name: "email", maxlength: "254", autocomplete: "off", value: client?.email || "" });
  const phone = h("input", { type: "tel", name: "phone", maxlength: "30", autocomplete: "off", placeholder: "e.g. 083 787 5826", value: client?.phone || "" });
  const address = h("textarea", { name: "address", rows: "3", maxlength: "300" }, client?.address || "");
  dialog(client ? `Edit ${client.name}` : "Add a client",
    h("div", { class: "fields" },
      field("Name", name), h("div", { class: "pair" }, field("Email", email), field("Cellphone", phone)),
      field("Default address", address, "Prefilled on new bookings for this client. You can change it per booking.")),
    async () => {
      const body = { name: name.value, email: email.value, phone: phone.value, address: address.value };
      return (await api("clients", { method: client ? "PATCH" : "POST", body: JSON.stringify(client ? { ...body, id: client.id } : body) })).client;
    }, null, onsaved);
}

async function removeClient(client, rentals) {
  if (rentals) { alert(`${client.name} has ${plural(rentals, "rental")}. Delete those rentals or move them to another client first.`); return; }
  if (!confirm(`Delete ${client.name}? This cannot be undone.`)) return;
  try { await api(`clients?id=${encodeURIComponent(client.id)}`, { method: "DELETE" }); await load(); }
  catch (error) { const message = handleError(error, "Could not delete the client."); if (message) alert(message); }
}

async function removeRental(rental) {
  if (!confirm(`Delete the rental for ${clientName(rental.clientId)} (${dateRange(rental.start, rental.end)})?`)) return;
  try { await api(`rentals?id=${encodeURIComponent(rental.id)}`, { method: "DELETE" }); await load(); }
  catch (error) { const message = handleError(error, "Could not delete the rental."); if (message) alert(message); }
}

async function removeScreen(screen, rentals) {
  if (rentals) { alert(`Screen #${screen.number} is on ${plural(rentals, "rental")}. Remove it from those rentals first, or mark it retired.`); return; }
  if (!confirm(`Delete screen #${screen.number}? This cannot be undone.`)) return;
  try { await api(`screens?id=${encodeURIComponent(screen.id)}`, { method: "DELETE" }); await load(); }
  catch (error) { const message = handleError(error, "Could not delete the screen."); if (message) alert(message); }
}

/* ---------- boot ---------- */

signoutButton.addEventListener("click", async () => {
  signoutButton.disabled = true;
  try { await api("session", { method: "DELETE" }); Object.assign(state, { auth: false, error: "", screens: [], clients: [], rentals: [] }); render(); }
  catch { alert("Could not sign out. Please try again."); }
  finally { signoutButton.disabled = false; }
});

api("session")
  .then(({ authenticated }) => { state.auth = authenticated; render(); if (authenticated) void load(); })
  .catch(error => { state.auth = false; state.error = error.message; render(); });
