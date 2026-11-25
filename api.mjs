// API de réservation des RDV InBody — Magic Fit, pôle santé
// Stockage : Netlify Blobs (aucun compte extérieur nécessaire)
// Une réservation = une clé "slot/AAAA-MM-JJ/HHMM" écrite avec onlyIfNew :
// si deux adhérents cliquent en même temps, un seul obtient le créneau.

import { getStore } from "@netlify/blobs";

const TZ = "Europe/Paris";

const DEFAULT_SETTINGS = {
  slotMinutes: 15,
  horizonDays: 21,          // réservable jusqu'à J+21
  minNoticeMinutes: 60,     // pas de réservation à moins d'1 h
  // 0 = dimanche … 6 = samedi ; plages "HH:MM-HH:MM"
  hours: {
    0: [],
    1: ["10:00-12:00", "14:00-19:00"],
    2: ["10:00-12:00", "14:00-19:00"],
    3: ["10:00-12:00", "14:00-19:00"],
    4: ["10:00-12:00", "14:00-19:00"],
    5: ["10:00-12:00", "14:00-19:00"],
    6: ["10:00-12:00"],
  },
  closedDays: [],           // ["2026-12-25", …]
  message: "",              // message affiché en haut de la page adhérents
};

const store = () => getStore({ name: "inbody", consistency: "strong" });

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
const err = (message, status = 400) => json({ error: message }, status);

// ---------- dates & heures (heure de Paris) ----------
function parisParts(ms) {
  const f = new Intl.DateTimeFormat("fr-FR", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
const todayParis = () => parisParts(Date.now()).date;
function addDays(date, n) {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const weekday = (date) => new Date(date + "T12:00:00Z").getUTCDay();
const toMin = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
const toTime = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + "T12:00:00Z"));
const isTime = (s) => typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const slotKey = (date, time) => `slot/${date}/${time.replace(":", "")}`;

function slotsForDay(settings, date) {
  if (settings.closedDays.includes(date)) return [];
  const ranges = settings.hours[weekday(date)] || [];
  const out = [];
  for (const r of ranges) {
    const [a, b] = r.split("-");
    if (!isTime(a) || !isTime(b)) continue;
    for (let m = toMin(a); m + settings.slotMinutes <= toMin(b); m += settings.slotMinutes) out.push(toTime(m));
  }
  return [...new Set(out)].sort();
}

// ---------- réglages ----------
async function getSettings() {
  const s = await store().get("settings", { type: "json" });
  return { ...DEFAULT_SETTINGS, ...(s || {}), hours: { ...DEFAULT_SETTINGS.hours, ...((s && s.hours) || {}) } };
}

async function takenForDay(date) {
  const { blobs } = await store().list({ prefix: `slot/${date}/` });
  return blobs.map((b) => b.key);
}

// Le créneau peut-il être réservé en ligne maintenant ?
function bookableNow(settings, date, time) {
  const today = todayParis();
  if (date < today || date > addDays(today, settings.horizonDays)) return false;
  const limit = parisParts(Date.now() + settings.minNoticeMinutes * 60000);
  return `${date} ${time}` >= `${limit.date} ${limit.time}`;
}

// ---------- validation ----------
const clean = (v, max) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, max) : "");
const normPhone = (t) => t.replace(/[^\d+]/g, "").replace(/^\+33/, "0").replace(/^0033/, "0");
function randomCode(n = 6) {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return [...bytes].map((b) => abc[b % abc.length]).join("");
}
// Code d'annulation : 20261126-1015-K7P3QX (contient le créneau + un secret)
function parseCode(code) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})-([A-Z0-9]{6})$/.exec(String(code || "").toUpperCase().trim());
  if (!m) return null;
  return { date: `${m[1]}-${m[2]}-${m[3]}`, time: `${m[4]}:${m[5]}`, secret: m[6], full: m[0] };
}

function readPerson(body) {
  const p = {
    prenom: clean(body.prenom, 50),
    nom: clean(body.nom, 50),
    tel: clean(body.tel, 25),
    email: clean(body.email, 120).toLowerCase(),
    note: clean(body.note, 300),
  };
  if (!p.prenom || !p.nom) return { error: "Merci d'indiquer votre prénom et votre nom." };
  if (normPhone(p.tel).replace("+", "").length < 10) return { error: "Numéro de téléphone invalide." };
  if (p.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) return { error: "Adresse e-mail invalide." };
  return { person: p };
}

async function createBooking(settings, date, time, person, source) {
  if (!slotsForDay(settings, date).includes(time)) return { error: "Ce créneau n'existe pas.", status: 400 };
  const secret = randomCode();
  const code = `${date.replace(/-/g, "")}-${time.replace(":", "")}-${secret}`;
  const booking = { type: "rdv", date, time, ...person, secret, source, createdAt: new Date().toISOString() };
  const { modified } = await store().setJSON(slotKey(date, time), booking, { onlyIfNew: true });
  if (!modified) return { error: "Désolé, ce créneau vient d'être réservé. Choisissez-en un autre.", status: 409 };
  return { code, booking };
}

// ---------- routes publiques ----------
async function publicSlots(url) {
  const settings = await getSettings();
  const today = todayParis();
  let from = url.searchParams.get("from");
  if (!isDate(from) || from < today) from = today;
  const n = Math.min(Math.max(parseInt(url.searchParams.get("days") || "7", 10) || 7, 1), 14);
  const last = addDays(today, settings.horizonDays);
  const dates = [];
  for (let i = 0; i < n; i++) { const d = addDays(from, i); if (d <= last) dates.push(d); }
  const days = await Promise.all(dates.map(async (date) => {
    const taken = new Set(await takenForDay(date));
    const free = slotsForDay(settings, date).filter((t) => !taken.has(slotKey(date, t)) && bookableNow(settings, date, t));
    return { date, slots: free };
  }));
  return json({
    today, lastDate: last, slotMinutes: settings.slotMinutes, message: settings.message,
    days, hasMore: addDays(from, n) <= last,
  });
}

async function publicBook(req) {
  const body = await req.json().catch(() => ({}));
  if (body.website) return json({ ok: true }); // pot de miel anti-robots
  const { date, time } = body;
  if (!isDate(date) || !isTime(time)) return err("Créneau invalide.");
  if (!body.consent) return err("Merci d'accepter l'utilisation de vos données pour ce rendez-vous.");
  const { person, error } = readPerson(body);
  if (error) return err(error);
  const settings = await getSettings();
  if (!bookableNow(settings, date, time)) return err("Ce créneau n'est plus réservable en ligne.");

  // Un seul RDV à venir par numéro de téléphone
  const phoneKey = `phone/${normPhone(person.tel)}`;
  const existing = await store().get(phoneKey, { type: "json" });
  if (existing && `${existing.date} ${existing.time}` >= `${todayParis()} 00:00`) {
    const still = await store().get(slotKey(existing.date, existing.time), { type: "json" });
    if (still && still.type === "rdv" && normPhone(still.tel) === normPhone(person.tel)) {
      return err("Vous avez déjà un RDV InBody à venir. Annulez-le d'abord si vous souhaitez en changer.");
    }
  }

  const r = await createBooking(settings, date, time, person, "en ligne");
  if (r.error) return err(r.error, r.status);
  await store().setJSON(phoneKey, { date, time });
  return json({ ok: true, code: r.code, date, time, prenom: person.prenom, slotMinutes: settings.slotMinutes });
}

async function findByCode(code) {
  const c = parseCode(code);
  if (!c) return null;
  const b = await store().get(slotKey(c.date, c.time), { type: "json" });
  if (!b || b.type !== "rdv" || b.secret !== c.secret) return null;
  return b;
}

async function publicLookup(url) {
  const b = await findByCode(url.searchParams.get("code"));
  if (!b) return err("Aucun rendez-vous trouvé avec ce code.", 404);
  return json({ date: b.date, time: b.time, prenom: b.prenom });
}

async function deleteBooking(b) {
  await store().delete(slotKey(b.date, b.time));
  if (b.tel) {
    const phoneKey = `phone/${normPhone(b.tel)}`;
    const p = await store().get(phoneKey, { type: "json" });
    if (p && p.date === b.date && p.time === b.time) await store().delete(phoneKey);
  }
}

async function publicCancel(req) {
  const body = await req.json().catch(() => ({}));
  const b = await findByCode(body.code);
  if (!b) return err("Aucun rendez-vous trouvé avec ce code.", 404);
  await deleteBooking(b);
  return json({ ok: true });
}

// ---------- espace accueil (mot de passe) ----------
function isAdmin(req) {
  const pass = process.env.ADMIN_PASSWORD || "";
  const given = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (pass.length < 6 || given.length !== pass.length) return false;
  let diff = 0;
  for (let i = 0; i < pass.length; i++) diff |= pass.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

async function adminDay(url) {
  const date = url.searchParams.get("date");
  if (!isDate(date)) return err("Date invalide.");
  const settings = await getSettings();
  const keys = await takenForDay(date);
  const entries = await Promise.all(keys.map((k) => store().get(k, { type: "json" })));
  const byTime = {};
  for (const e of entries) if (e) byTime[e.time] = e;
  const times = [...new Set([...slotsForDay(settings, date), ...Object.keys(byTime)])].sort();
  const slots = times.map((time) => {
    const e = byTime[time];
    if (!e) return { time, status: "libre" };
    if (e.type === "blocked") return { time, status: "bloqué" };
    const { secret, ...rest } = e;
    return { time, status: "réservé", booking: rest };
  });
  return json({ date, closed: settings.closedDays.includes(date), slots });
}

async function adminAction(req, action) {
  const body = await req.json().catch(() => ({}));
  const settings = await getSettings();
  if (action === "settings") {
    if (req.method === "GET") return json(settings);
    const s = body.settings || {};
    const next = { ...settings };
    if ([10, 15, 20, 30].includes(Number(s.slotMinutes))) next.slotMinutes = Number(s.slotMinutes);
    if (Number.isInteger(s.horizonDays) && s.horizonDays >= 1 && s.horizonDays <= 90) next.horizonDays = s.horizonDays;
    if (Number.isInteger(s.minNoticeMinutes) && s.minNoticeMinutes >= 0 && s.minNoticeMinutes <= 2880) next.minNoticeMinutes = s.minNoticeMinutes;
    if (s.hours && typeof s.hours === "object") {
      next.hours = {};
      for (let d = 0; d < 7; d++) {
        const list = Array.isArray(s.hours[d]) ? s.hours[d] : [];
        next.hours[d] = list.filter((r) => /^\d{2}:\d{2}-\d{2}:\d{2}$/.test(r) && isTime(r.slice(0, 5)) && isTime(r.slice(6)) && r.slice(0, 5) < r.slice(6));
      }
    }
    if (Array.isArray(s.closedDays)) next.closedDays = [...new Set(s.closedDays.filter(isDate))].sort();
    if (typeof s.message === "string") next.message = clean(s.message, 280);
    await store().setJSON("settings", next);
    return json(next);
  }

  const { date, time } = body;
  if (!isDate(date) || !isTime(time)) return err("Créneau invalide.");
  const key = slotKey(date, time);

  if (action === "book") {
    const { person, error } = readPerson({ ...body, tel: body.tel || "0000000000" });
    if (error) return err(error);
    if (!body.tel) person.tel = "";
    const r = await createBooking(settings, date, time, person, "accueil");
    if (r.error) return err(r.error, r.status);
    if (person.tel) await store().setJSON(`phone/${normPhone(person.tel)}`, { date, time });
    return json({ ok: true, code: r.code });
  }
  if (action === "cancel") {
    const b = await store().get(key, { type: "json" });
    if (b && b.type === "rdv") await deleteBooking(b);
    return json({ ok: true });
  }
  if (action === "block") {
    const { modified } = await store().setJSON(key, { type: "blocked", date, time }, { onlyIfNew: true });
    if (!modified) return err("Ce créneau est déjà pris ou bloqué.", 409);
    return json({ ok: true });
  }
  if (action === "unblock") {
    const b = await store().get(key, { type: "json" });
    if (b && b.type === "blocked") await store().delete(key);
    return json({ ok: true });
  }
  return err("Action inconnue.", 404);
}

// ---------- routeur ----------
export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api\/?/, "").replace(/\/$/, "");
  try {
    if (req.method === "GET" && path === "slots") return await publicSlots(url);
    if (req.method === "GET" && path === "booking") return await publicLookup(url);
    if (req.method === "POST" && path === "book") return await publicBook(req);
    if (req.method === "POST" && path === "cancel") return await publicCancel(req);

    if (path.startsWith("admin")) {
      if (!process.env.ADMIN_PASSWORD) return err("Mot de passe accueil non configuré sur Netlify (variable ADMIN_PASSWORD).", 500);
      if (!isAdmin(req)) return err("Mot de passe incorrect.", 401);
      const action = path.split("/")[1] || "";
      if (action === "login") return json({ ok: true });
      if (action === "day" && req.method === "GET") return await adminDay(url);
      if (action === "settings") return await adminAction(req, "settings");
      if (req.method === "POST") return await adminAction(req, action);
    }
    return err("Introuvable.", 404);
  } catch (e) {
    console.error(e);
    return err("Erreur serveur, réessayez dans un instant.", 500);
  }
};

export const config = { path: "/api/*" };
