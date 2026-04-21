// ════════════════════════════════════════════════════════════════
// PeopleFlow Bridge v3 — Read/Write + Resume streaming + Offer Letters
// ════════════════════════════════════════════════════════════════
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

// ── Config ──
const SQLITE_PATH = process.env.REFERRAL_DB_PATH
  || '/root/parakh-referral-portal/referral_portal.db';
const UPLOADS_DIR = process.env.REFERRAL_UPLOADS_DIR
  || '/root/parakh-referral-portal/uploads';
const PORT = process.env.PORT || 3002;
const API_KEY = process.env.API_KEY || 'pcg-peopleflow-2026-x9Kd7mN3pQr8';

// Public base URL (where candidates click offer accept/decline links)
const PUBLIC_BASE = process.env.PUBLIC_BASE || 'https://hr-api.pcg.net.in';

const ALLOWED_ORIGINS = [
  'https://hr.pcg.net.in', 'http://hr.pcg.net.in',
  'http://localhost:3000', 'http://127.0.0.1:3000'
];

// ── Open SQLite (read/write) ──
const db = new Database(SQLITE_PATH, { fileMustExist: true });
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
console.log('[PeopleFlow Bridge] Opened SQLite (rw):', SQLITE_PATH);

// ── Create our own tables (without touching referral portal tables) ──
db.exec(`
  CREATE TABLE IF NOT EXISTS pf_offer_letters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    referral_id INTEGER NOT NULL,
    candidate_name TEXT,
    candidate_email TEXT,
    pdf_url TEXT NOT NULL,
    subject TEXT,
    email_body TEXT,
    status TEXT DEFAULT 'Draft',
    token TEXT UNIQUE,
    sent_at DATETIME,
    responded_at DATETIME,
    response_note TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS pf_info_form_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    referral_id INTEGER NOT NULL,
    sent_to_email TEXT,
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    note TEXT
  );

  CREATE TABLE IF NOT EXISTS pf_filled_applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    referral_id INTEGER NOT NULL,
    filename TEXT,
    uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    notes TEXT
  );

  CREATE TABLE IF NOT EXISTS pf_interview_schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    referral_id INTEGER NOT NULL,
    candidate_name TEXT,
    candidate_email TEXT,
    position TEXT,
    round TEXT,
    date TEXT,
    time TEXT,
    mode TEXT,
    duration TEXT,
    location TEXT,
    interviewer_emails TEXT,
    guest_emails TEXT,
    notes TEXT,
    status TEXT DEFAULT 'Scheduled',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS pf_interview_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schedule_id INTEGER NOT NULL,
    rating_tech INTEGER DEFAULT 0,
    rating_comm INTEGER DEFAULT 0,
    rating_prob INTEGER DEFAULT 0,
    rating_cult INTEGER DEFAULT 0,
    rating_overall INTEGER DEFAULT 0,
    strengths TEXT,
    improve TEXT,
    comments TEXT,
    decision TEXT,
    submitted_by TEXT,
    submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (schedule_id) REFERENCES pf_interview_schedules(id)
  );
`);

// ── App ──
const app = express();

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('Origin not allowed'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-api-key']
}));

app.use(express.json({ limit: '1mb' }));

function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (key !== API_KEY) return res.status(401).json({ success: false, error: 'Unauthorized.' });
  next();
}

function addSixMonths(ds) {
  const d = new Date(ds);
  d.setMonth(d.getMonth() + 6);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function genToken() {
  return crypto.randomBytes(24).toString('hex');
}

// ══════════════════════════════════════════════════════
// PUBLIC — health check
// ══════════════════════════════════════════════════════
app.get('/api/health', (req, res) => {
  res.json({ success: true, service: 'peopleflow-bridge', version: '3.2', time: new Date().toISOString(), db: SQLITE_PATH });
});

// ══════════════════════════════════════════════════════
// READS
// ══════════════════════════════════════════════════════
app.get('/api/candidates', requireApiKey, (req, res) => {
  try {
    const rows = db.prepare(`SELECT r.id, r.candidate_name, r.candidate_email, r.candidate_phone, r.candidate_relationship, r.candidate_relationship_other, r.candidate_opinion, r.referred_branch, r.resume_filename, r.interview_pdf, r.status, r.date_of_joining, r.bonus_eligible_date, r.date_of_leaving, r.bonus_status, r.bonus_claim_date, r.bonus_rejection_reason, r.ineligible_reason, r.created_at, r.updated_at, p.title AS position_title, p.bonus_amount AS position_bonus, e.name AS referrer_name, e.employee_code AS referrer_code, e.email AS referrer_email FROM referrals r LEFT JOIN positions p ON r.position_id=p.id LEFT JOIN employees e ON r.referrer_id=e.id ORDER BY r.created_at DESC`).all();
    const sr = db.prepare(`SELECT COUNT(*) AS count, SUM(CASE WHEN result='Pass' THEN 1 ELSE 0 END) AS passed, SUM(CASE WHEN result='Reject' THEN 1 ELSE 0 END) AS rejected FROM interview_rounds WHERE referral_id=?`);
    // Also pull latest offer status
    const so = db.prepare(`SELECT status, sent_at, responded_at FROM pf_offer_letters WHERE referral_id=? ORDER BY id DESC LIMIT 1`);
    const sf = db.prepare(`SELECT sent_at FROM pf_info_form_log WHERE referral_id=? ORDER BY id DESC LIMIT 1`);
    rows.forEach(r => {
      const s = sr.get(r.id) || {};
      r.rounds_count = s.count || 0;
      r.rounds_passed = s.passed || 0;
      r.rounds_rejected = s.rejected || 0;
      const off = so.get(r.id);
      r.offer_status = off ? off.status : null;
      r.offer_sent_at = off ? off.sent_at : null;
      r.offer_responded_at = off ? off.responded_at : null;
      const info = sf.get(r.id);
      r.info_form_sent_at = info ? info.sent_at : null;
    });
    res.json({ success: true, count: rows.length, candidates: rows });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/candidates/:id/rounds', requireApiKey, (req, res) => {
  try {
    const rounds = db.prepare(`SELECT id, round_type, interviewer_name, result, remarks, saved_at FROM interview_rounds WHERE referral_id=? ORDER BY id ASC`).all(req.params.id);
    res.json({ success: true, rounds });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/positions', requireApiKey, (req, res) => {
  try {
    const positions = db.prepare(`SELECT id, title, bonus_amount, is_active FROM positions ORDER BY title ASC`).all();
    res.json({ success: true, positions });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/referrers', requireApiKey, (req, res) => {
  try {
    const employees = db.prepare(`SELECT id, name, employee_code, email, role, is_active FROM employees ORDER BY name ASC`).all();
    res.json({ success: true, employees });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ══════════════════════════════════════════════════════
// RESUME STREAMING — serves files from referral portal uploads folder
// ══════════════════════════════════════════════════════
app.get('/api/resumes/:filename', requireApiKey, (req, res) => {
  try {
    const filename = path.basename(req.params.filename); // prevent traversal
    const fp = path.join(UPLOADS_DIR, filename);
    if (!fs.existsSync(fp)) return res.status(404).json({ success: false, error: 'Resume not found' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="' + filename + '"');
    fs.createReadStream(fp).pipe(res);
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/interview-pdf/:filename', requireApiKey, (req, res) => {
  try {
    const filename = path.basename(req.params.filename);
    const fp = path.join(UPLOADS_DIR, filename);
    if (!fs.existsSync(fp)) return res.status(404).json({ success: false, error: 'File not found' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="' + filename + '"');
    fs.createReadStream(fp).pipe(res);
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ══════════════════════════════════════════════════════
// WRITES — Interview rounds
// ══════════════════════════════════════════════════════
app.post('/api/candidates/:id/rounds', requireApiKey, (req, res) => {
  const id = req.params.id;
  const { round_id, round_type, interviewer_name, result, remarks } = req.body || {};
  if (!round_type || !interviewer_name || !result) return res.status(400).json({ success: false, error: 'round_type, interviewer_name, result required.' });
  if (!['Pass', 'Reject'].includes(result)) return res.status(400).json({ success: false, error: "result must be 'Pass' or 'Reject'." });
  try {
    const tx = db.transaction(() => {
      if (round_id) {
        db.prepare(`UPDATE interview_rounds SET round_type=?, interviewer_name=?, result=?, remarks=?, saved_at=CURRENT_TIMESTAMP WHERE id=? AND referral_id=?`).run(round_type, interviewer_name, result, remarks || null, round_id, id);
      } else {
        db.prepare(`INSERT INTO interview_rounds (referral_id, round_type, interviewer_name, result, remarks) VALUES (?,?,?,?,?)`).run(id, round_type, interviewer_name, result, remarks || null);
      }
      if (result === 'Reject') db.prepare(`UPDATE referrals SET status='Rejected', updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(id);
    });
    tx();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.delete('/api/candidates/:id/rounds/:roundId', requireApiKey, (req, res) => {
  try {
    const info = db.prepare(`DELETE FROM interview_rounds WHERE id=? AND referral_id=?`).run(req.params.roundId, req.params.id);
    res.json({ success: true, deleted: info.changes });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ══════════════════════════════════════════════════════
// WRITES — Status
// ══════════════════════════════════════════════════════
app.post('/api/candidates/:id/status', requireApiKey, (req, res) => {
  const { status, date_of_joining } = req.body || {};
  if (!['In Progress', 'Selected', 'Rejected', 'Withdrawn'].includes(status)) return res.status(400).json({ success: false, error: 'Invalid status.' });
  try {
    if (status === 'Selected') {
      if (!date_of_joining) return res.status(400).json({ success: false, error: 'date_of_joining required.' });
      const bd = addSixMonths(date_of_joining);
      db.prepare(`UPDATE referrals SET status=?, date_of_joining=?, bonus_eligible_date=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(status, date_of_joining, bd, req.params.id);
    } else {
      db.prepare(`UPDATE referrals SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(status, req.params.id);
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/candidates/:id/select', requireApiKey, (req, res) => {
  const { date_of_joining } = req.body || {};
  if (!date_of_joining) return res.status(400).json({ success: false, error: 'date_of_joining required.' });
  try {
    const bd = addSixMonths(date_of_joining);
    db.prepare(`UPDATE referrals SET status='Selected', date_of_joining=?, bonus_eligible_date=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(date_of_joining, bd, req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/candidates/:id/withdraw', requireApiKey, (req, res) => {
  try {
    db.prepare(`UPDATE referrals SET status='Withdrawn', updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ══════════════════════════════════════════════════════
// INFO FORM LOG — admin records "sent info form to candidate"
// ══════════════════════════════════════════════════════
app.post('/api/candidates/:id/info-form-sent', requireApiKey, (req, res) => {
  const { sent_to_email, note } = req.body || {};
  try {
    db.prepare(`INSERT INTO pf_info_form_log (referral_id, sent_to_email, note) VALUES (?,?,?)`).run(req.params.id, sent_to_email || null, note || null);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ══════════════════════════════════════════════════════
// OFFER LETTERS
// ══════════════════════════════════════════════════════

// List all offer letters
app.get('/api/offers', requireApiKey, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT o.*, r.candidate_name AS referral_name, r.candidate_email AS referral_email, r.candidate_phone, p.title AS position_title
      FROM pf_offer_letters o
      LEFT JOIN referrals r ON o.referral_id = r.id
      LEFT JOIN positions p ON r.position_id = p.id
      ORDER BY o.created_at DESC
    `).all();
    res.json({ success: true, offers: rows });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Create a new offer letter (Draft)
app.post('/api/offers', requireApiKey, (req, res) => {
  const { referral_id, pdf_url, subject, email_body } = req.body || {};
  if (!referral_id || !pdf_url) return res.status(400).json({ success: false, error: 'referral_id and pdf_url required.' });
  try {
    const r = db.prepare('SELECT candidate_name, candidate_email FROM referrals WHERE id=?').get(referral_id);
    if (!r) return res.status(404).json({ success: false, error: 'Referral not found.' });
    const token = genToken();
    const info = db.prepare(`
      INSERT INTO pf_offer_letters (referral_id, candidate_name, candidate_email, pdf_url, subject, email_body, status, token)
      VALUES (?,?,?,?,?,?,'Draft',?)
    `).run(referral_id, r.candidate_name, r.candidate_email, pdf_url, subject || null, email_body || null, token);
    res.json({ success: true, id: info.lastInsertRowid, token, accept_url: PUBLIC_BASE + '/offer/accept/' + token, decline_url: PUBLIC_BASE + '/offer/decline/' + token });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Mark offer as sent (PeopleFlow calls this AFTER EmailJS send() succeeds)
app.post('/api/offers/:id/mark-sent', requireApiKey, (req, res) => {
  try {
    db.prepare(`UPDATE pf_offer_letters SET status='Sent', sent_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Update offer letter (edit subject/body/pdf before sending)
app.put('/api/offers/:id', requireApiKey, (req, res) => {
  const { pdf_url, subject, email_body } = req.body || {};
  try {
    db.prepare(`UPDATE pf_offer_letters SET pdf_url=COALESCE(?,pdf_url), subject=COALESCE(?,subject), email_body=COALESCE(?,email_body), updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(pdf_url || null, subject || null, email_body || null, req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Delete an offer letter (only if still Draft)
app.delete('/api/offers/:id', requireApiKey, (req, res) => {
  try {
    const info = db.prepare(`DELETE FROM pf_offer_letters WHERE id=? AND status='Draft'`).run(req.params.id);
    if (info.changes === 0) return res.status(400).json({ success: false, error: 'Can only delete Draft offers.' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Get one offer by token (public, for candidate accept/decline pages)
app.get('/api/offers/by-token/:token', (req, res) => {
  try {
    const row = db.prepare(`SELECT id, referral_id, candidate_name, candidate_email, pdf_url, subject, status, sent_at, responded_at FROM pf_offer_letters WHERE token=?`).get(req.params.token);
    if (!row) return res.status(404).json({ success: false, error: 'Invalid or expired link.' });
    res.json({ success: true, offer: row });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── PUBLIC CANDIDATE ENDPOINTS (no API key — candidates click email link) ──

function renderOfferResponse(title, message, color) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:'Segoe UI',Arial,sans-serif;background:#f5f6fa;margin:0;padding:40px 20px;display:flex;align-items:center;justify-content:center;min-height:100vh}.card{max-width:520px;background:white;border-radius:16px;padding:40px 32px;box-shadow:0 10px 30px rgba(0,0,0,0.08);text-align:center}.icon{font-size:56px;margin-bottom:16px}.title{font-size:22px;font-weight:700;color:${color};margin-bottom:10px}.msg{color:#555;line-height:1.5;margin-bottom:20px}.logo{font-size:13px;color:#999;border-top:1px solid #eee;padding-top:16px;margin-top:20px}</style></head>
<body><div class="card"><div class="icon">${color === '#1db36b' ? '✅' : color === '#e74c3c' ? '❌' : 'ℹ️'}</div><div class="title">${title}</div><div class="msg">${message}</div><div class="logo">Parakh Consulting LLP — PeopleFlow</div></div></body></html>`;
}

app.get('/offer/accept/:token', (req, res) => {
  try {
    const off = db.prepare(`SELECT id, candidate_name, status FROM pf_offer_letters WHERE token=?`).get(req.params.token);
    if (!off) return res.status(404).send(renderOfferResponse('Invalid Link', 'This offer link is invalid or has expired. Please contact HR if you need assistance.', '#e74c3c'));
    if (off.status === 'Accepted') return res.send(renderOfferResponse('Already Accepted', 'You have already accepted this offer. Our HR team will reach out with next steps soon.', '#1db36b'));
    if (off.status === 'Declined') return res.send(renderOfferResponse('Already Declined', 'You previously declined this offer. If this was a mistake, please contact HR.', '#e74c3c'));
    db.prepare(`UPDATE pf_offer_letters SET status='Accepted', responded_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(off.id);
    res.send(renderOfferResponse('Offer Accepted — Welcome to PCG!', 'Thank you, ' + (off.candidate_name || 'Candidate') + '! Your acceptance has been recorded. Our HR team will contact you shortly with onboarding details and your joining date.', '#1db36b'));
  } catch (e) { res.status(500).send(renderOfferResponse('Error', e.message, '#e74c3c')); }
});

app.get('/offer/decline/:token', (req, res) => {
  try {
    const off = db.prepare(`SELECT id, candidate_name, status FROM pf_offer_letters WHERE token=?`).get(req.params.token);
    if (!off) return res.status(404).send(renderOfferResponse('Invalid Link', 'This offer link is invalid or has expired.', '#e74c3c'));
    if (off.status === 'Declined') return res.send(renderOfferResponse('Already Declined', 'You have already declined this offer.', '#e74c3c'));
    if (off.status === 'Accepted') return res.send(renderOfferResponse('Already Accepted', 'You already accepted this offer. If you wish to decline, please contact HR.', '#1db36b'));
    db.prepare(`UPDATE pf_offer_letters SET status='Declined', responded_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(off.id);
    res.send(renderOfferResponse('Offer Declined', 'Your decision has been recorded. We appreciate your time and wish you the best in your career, ' + (off.candidate_name || 'Candidate') + '.', '#e74c3c'));
  } catch (e) { res.status(500).send(renderOfferResponse('Error', e.message, '#e74c3c')); }
});

// ══════════════════════════════════════════════════════
// INTERVIEW SCHEDULES (cross-device scheduling sync)
// ══════════════════════════════════════════════════════

// List all scheduled interviews with feedback joined
app.get('/api/interviews', requireApiKey, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT s.*,
             f.rating_tech, f.rating_comm, f.rating_prob, f.rating_cult, f.rating_overall,
             f.strengths, f.improve, f.comments, f.decision, f.submitted_at AS feedback_submitted_at, f.submitted_by,
             r.candidate_name AS referral_name, r.candidate_email AS referral_email,
             p.title AS position_title
      FROM pf_interview_schedules s
      LEFT JOIN pf_interview_feedback f ON s.id = f.schedule_id
      LEFT JOIN referrals r ON s.referral_id = r.id
      LEFT JOIN positions p ON r.position_id = p.id
      ORDER BY s.date ASC, s.time ASC
    `).all();
    res.json({ success: true, interviews: rows });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Create a new scheduled interview
app.post('/api/interviews', requireApiKey, (req, res) => {
  const {
    referral_id, candidate_name, candidate_email, position, round,
    date, time, mode, duration, location, interviewer_emails,
    guest_emails, notes
  } = req.body || {};
  if (!referral_id) return res.status(400).json({ success: false, error: 'referral_id required' });
  if (!round || !date || !time) return res.status(400).json({ success: false, error: 'round, date, time required' });
  try {
    const info = db.prepare(`
      INSERT INTO pf_interview_schedules
        (referral_id, candidate_name, candidate_email, position, round, date, time, mode, duration, location, interviewer_emails, guest_emails, notes, status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'Scheduled')
    `).run(referral_id, candidate_name || null, candidate_email || null, position || null, round, date, time, mode || null, duration || null, location || null, interviewer_emails || null, guest_emails || null, notes || null);
    res.json({ success: true, id: info.lastInsertRowid });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Update interview status (Scheduled -> Completed / Cancelled)
app.put('/api/interviews/:id', requireApiKey, (req, res) => {
  const { status, notes } = req.body || {};
  try {
    const parts = [];
    const vals = [];
    if (status) { parts.push('status=?'); vals.push(status); }
    if (notes !== undefined) { parts.push('notes=?'); vals.push(notes); }
    if (!parts.length) return res.json({ success: true });
    parts.push('updated_at=CURRENT_TIMESTAMP');
    vals.push(req.params.id);
    db.prepare(`UPDATE pf_interview_schedules SET ${parts.join(',')} WHERE id=?`).run(...vals);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Delete / cancel an interview
app.delete('/api/interviews/:id', requireApiKey, (req, res) => {
  try {
    const tx = db.transaction(() => {
      db.prepare(`DELETE FROM pf_interview_feedback WHERE schedule_id=?`).run(req.params.id);
      db.prepare(`DELETE FROM pf_interview_schedules WHERE id=?`).run(req.params.id);
    });
    tx();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Submit feedback for an interview
app.post('/api/interviews/:id/feedback', requireApiKey, (req, res) => {
  const {
    rating_tech, rating_comm, rating_prob, rating_cult, rating_overall,
    strengths, improve, comments, decision, submitted_by
  } = req.body || {};
  if (!decision) return res.status(400).json({ success: false, error: 'decision required' });
  try {
    const tx = db.transaction(() => {
      // Remove old feedback (allow resubmit)
      db.prepare(`DELETE FROM pf_interview_feedback WHERE schedule_id=?`).run(req.params.id);
      db.prepare(`
        INSERT INTO pf_interview_feedback
          (schedule_id, rating_tech, rating_comm, rating_prob, rating_cult, rating_overall, strengths, improve, comments, decision, submitted_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `).run(req.params.id, rating_tech|0, rating_comm|0, rating_prob|0, rating_cult|0, rating_overall|0, strengths || null, improve || null, comments || null, decision, submitted_by || null);
      // Also mark schedule as Completed
      db.prepare(`UPDATE pf_interview_schedules SET status='Completed', updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(req.params.id);
    });
    tx();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ══════════════════════════════════════════════════════
// NIGHTLY AUTO-CHECKOUT (runs on the bridge 24/7)
// At 11:55 PM every day, calls Supabase to auto-checkout anyone
// who checked in today but didn't check out.
// Completely server-side - doesn't require any browser to be open.
// ══════════════════════════════════════════════════════
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://prcgdpvogoqtgfpprktu.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_qPgML8EuJU04mcKGbWTkLA_7b4iwLZX';

async function supabaseFetch(path, options = {}) {
  const url = SUPABASE_URL + '/rest/v1' + path;
  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation',
    ...(options.headers || {})
  };
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error('Supabase ' + res.status + ': ' + errText);
  }
  return res.json();
}

function localDateStr(d = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

async function runNightlyAutoCheckout() {
  try {
    const today = localDateStr();
    console.log('[AutoCheckout] Running for ' + today);
    // Find today's attendance records where in_time is set but out_time is empty/null
    const rows = await supabaseFetch(`/attendance?date=eq.${today}&in_time=not.is.null&select=id,emp_id,emp_name,in_time,out_time`);
    const incomplete = rows.filter(r => !r.out_time);
    console.log('[AutoCheckout] Found ' + incomplete.length + ' incomplete check-ins');
    if (!incomplete.length) return;

    // Update each
    for (const r of incomplete) {
      try {
        await supabaseFetch(`/attendance?id=eq.${r.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ out_time: '11:50 PM', auto_checkout: true })
        });
        console.log('[AutoCheckout] ✓ ' + r.emp_id + ' (' + r.emp_name + ')');
      } catch (e) {
        console.error('[AutoCheckout] ✗ ' + r.emp_id + ': ' + e.message);
      }
    }
    console.log('[AutoCheckout] Done. Processed ' + incomplete.length + ' records.');
  } catch (e) {
    console.error('[AutoCheckout] Failed:', e.message);
  }
}

function scheduleNightlyAutoCheckout() {
  const now = new Date();
  const target = new Date(now);
  target.setHours(23, 55, 0, 0);
  let ms = target - now;
  if (ms <= 0) {
    // Already past 11:55 PM today — schedule for tomorrow
    ms += 24 * 60 * 60 * 1000;
  }
  console.log('[AutoCheckout] Next run in ' + Math.round(ms / 60000) + ' minutes (' + target.toLocaleString('en-IN') + ')');
  setTimeout(async () => {
    await runNightlyAutoCheckout();
    // Then repeat every 24 hours
    setInterval(runNightlyAutoCheckout, 24 * 60 * 60 * 1000);
  }, ms);
}

// Manual trigger endpoint (for admin testing / emergencies)
app.post('/api/admin/run-auto-checkout', requireApiKey, async (req, res) => {
  try {
    await runNightlyAutoCheckout();
    res.json({ success: true, message: 'Auto-checkout triggered manually. See PM2 logs.' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Start the schedule when the server boots
scheduleNightlyAutoCheckout();

// ══════════════════════════════════════════════════════
// 404 + startup
// ══════════════════════════════════════════════════════
app.use((req, res) => { res.status(404).json({ success: false, error: 'Not found' }); });

app.listen(PORT, () => {
  console.log('[PeopleFlow Bridge] v3 listening on http://localhost:' + PORT);
});

function shutdown() {
  try { db.close(); } catch (e) {}
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
