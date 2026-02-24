/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║               ExamPortal — app.js                       ║
 * ║  Handles login, question loading, exam flow, scoring,   ║
 * ║  and result submission to Google Apps Script.           ║
 * ╚══════════════════════════════════════════════════════════╝
 *
 * HOW TO DEPLOY — quick reference
 * ─────────────────────────────────────────────────────────
 * 1. Create Google Apps Script (appsscript.google.com)
 *    → Paste the GAS code from README
 *    → Deploy as Web App (access: Anyone)
 *    → Copy the /exec URL
 *
 * 2. Encode the URL to base64:
 *    In browser console:  btoa("https://script.google.com/macros/s/YOURSCRIPT/exec")
 *
 * 3. Paste the result into data.json fields:
 *    "endpoint_questions" — fetches questions from the GAS
 *    "endpoint_results"   — receives submitted answers
 *
 * 4. Generate SHA-256 password hashes:
 *    In browser console:
 *      async function hash(p){const b=new TextEncoder().encode(p);
 *      const h=await crypto.subtle.digest('SHA-256',b);
 *      return [...new Uint8Array(h)].map(x=>x.toString(16).padStart(2,'0')).join('');}
 *      hash("mypassword").then(console.log);
 *    Paste the result into data.json under "users".
 *
 * 5. Push index.html, app.js, data.json to a GitHub repo
 *    → Settings → Pages → Deploy from main branch / root
 */

'use strict';

/* ─────────────────────────────────────────────────────────────
   MODULE: App
   Single namespace to avoid polluting global scope.
───────────────────────────────────────────────────────────── */
const App = (() => {

  /* ── State ─────────────────────────────────────── */
  let config     = null;   // parsed data.json
  let questions  = [];     // array of question objects from GAS
  let currentUser = null;  // logged-in username
  let examTitle   = 'Online Exam'; // topic title from sheet H1

  /* ── Utility: SHA-256 via Web Crypto API ───────── */
  /**
   * Returns lowercase hex SHA-256 digest of a string.
   * Uses the browser's native crypto.subtle — no libraries needed.
   */
  async function sha256(str) {
    const buffer = new TextEncoder().encode(str);
    const hash   = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(hash))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /* ── Utility: base64 decode ─────────────────────── */
  /**
   * Decodes a base64 string to a UTF-8 string.
   * Endpoints are stored base64-encoded in data.json so they
   * are not trivially visible in plain text in your source files.
   */
  function b64decode(str) {
    return decodeURIComponent(
      atob(str)
        .split('')
        .map(c => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'))
        .join('')
    );
  }

  /* ── Utility: shuffle array (Fisher-Yates) ─────── */
  function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /* ── Utility: view switcher ─────────────────────── */
  function showView(id) {
    document.querySelectorAll('.view').forEach(v => {
      v.classList.toggle('active', v.id === id);
    });
  }

  /* ─────────────────────────────────────────────────────────
     STEP 1 — Load data.json on page load
     data.json contains:
       • endpoint_questions (base64) — GAS URL to fetch Qs
       • endpoint_results   (base64) — GAS URL to POST results
       • users { username: sha256hash }
  ───────────────────────────────────────────────────────── */
  async function init() {
    try {
      const res = await fetch('./data.json');
      if (!res.ok) throw new Error('Cannot load data.json');
      config = await res.json();
    } catch (err) {
      alert('Failed to load configuration. Make sure data.json exists.\n' + err.message);
    }

    // Allow submitting via Enter key
    document.getElementById('password').addEventListener('keydown', e => {
      if (e.key === 'Enter') login();
    });
    document.getElementById('username').addEventListener('keydown', e => {
      if (e.key === 'Enter') login();
    });
  }

  /* ─────────────────────────────────────────────────────────
     STEP 2 — Login
     1. Read username + password from form
     2. Hash password with SHA-256
     3. Compare with stored hash in data.json
     4. On success → load questions
  ───────────────────────────────────────────────────────── */
  async function login() {
    const usernameInput = document.getElementById('username').value.trim();
    const passwordInput = document.getElementById('password').value;
    const errorEl       = document.getElementById('login-error');
    const loginBtn      = document.getElementById('login-btn');

    // Clear previous error
    errorEl.classList.remove('visible');

    if (!usernameInput || !passwordInput) {
      errorEl.textContent = 'Please enter both username and password.';
      errorEl.classList.add('visible');
      return;
    }

    loginBtn.disabled    = true;
    loginBtn.textContent = 'Verifying…';

    const hash = await sha256(passwordInput);
    const users = config?.users || {};

    if (users[usernameInput] && users[usernameInput] === hash) {
      // ✅ Login success
      currentUser = usernameInput;
      loginBtn.textContent = 'Loading exam…';
      await loadQuestions();
    } else {
      // ❌ Login failure
      errorEl.textContent = 'Invalid username or password. Please try again.';
      errorEl.classList.add('visible');
      loginBtn.disabled    = false;
      loginBtn.textContent = 'Login';
    }
  }

  /* ─────────────────────────────────────────────────────────
     STEP 3 — Load questions from Google Apps Script
     The GAS web app reads from the "Questions" sheet and
     returns JSON like:
       [{ id, question, a, b, c, d, correct }, …]

     The endpoint URL is base64-decoded at runtime.
  ───────────────────────────────────────────────────────── */
  async function loadQuestions() {
    const endpoint = b64decode(config.endpoint_questions);

    try {
      const res  = await fetch(endpoint);
      const data = await res.json();

      // GAS returns { title: "...", questions: [...] }
      // Support both formats: plain array (old) or object with title (new)
      if (Array.isArray(data)) {
        questions = shuffle(data);
        examTitle = 'Online Exam';
      } else {
        examTitle = data.title || 'Online Exam';
        questions = shuffle(data.questions || []);
      }

      if (questions.length === 0) {
        throw new Error('No questions returned. Check your Google Sheet.');
      }

      renderExam();
    } catch (err) {
      alert('Failed to load questions:\n' + err.message);
      document.getElementById('login-btn').disabled = false;
      document.getElementById('login-btn').textContent = 'Login';
    }
  }

  /* ─────────────────────────────────────────────────────────
     STEP 4 — Render exam questions in the DOM
     Each question is wrapped in a .q-card with 4 radio options.
     Questions are already shuffled in loadQuestions().
  ───────────────────────────────────────────────────────── */
  function renderExam() {
    document.getElementById('exam-username').textContent = currentUser;
    document.getElementById('exam-title').textContent    = examTitle;
    document.getElementById('question-count').textContent =
      `${questions.length} question${questions.length !== 1 ? 's' : ''}`;

    const container = document.getElementById('questions-container');
    container.innerHTML = '';

    // ── Block text copying on exam body ──────────────
    const examBody = document.querySelector('.exam-body');
    examBody.addEventListener('copy',        e => e.preventDefault());
    examBody.addEventListener('cut',         e => e.preventDefault());
    examBody.addEventListener('contextmenu', e => e.preventDefault());

    questions.forEach((q, idx) => {
      // Only 3 options: A, B, C
      const options = [
        { key: 'A', text: q.option_a },
        { key: 'B', text: q.option_b },
        { key: 'C', text: q.option_c },
      ];

      const card = document.createElement('div');
      card.className = 'q-card';
      card.style.animationDelay = `${idx * 0.05}s`;
      card.dataset.qid     = q.question_id;
      card.dataset.correct = q.correct_answer; // A/B/C

      card.innerHTML = `
        <div class="q-num">Question ${idx + 1}</div>
        <div class="q-text">${escapeHtml(q.question_text)}</div>
        <div class="options">
          ${options.map(opt => `
            <label class="option-label">
              <input type="radio" name="q_${q.question_id}" value="${opt.key}" />
              <span class="option-key">${opt.key}</span>
              <span>${escapeHtml(opt.text)}</span>
            </label>
          `).join('')}
        </div>
      `;

      container.appendChild(card);
    });

    showView('exam-view');
  }

  /* ─────────────────────────────────────────────────────────
     STEP 5 — Submit exam
     1. Collect all radio answers
     2. Validate all answered
     3. Calculate score client-side
     4. POST to Google Apps Script endpoint
     5. Show result page
  ───────────────────────────────────────────────────────── */
  async function submit() {
    const cards  = document.querySelectorAll('.q-card');
    const answers = {};
    let   missing = false;

    // Collect answers
    cards.forEach(card => {
      const qid     = card.dataset.qid;
      const checked = card.querySelector('input[type="radio"]:checked');
      if (!checked) { missing = true; return; }
      answers[qid] = checked.value; // 'A','B','C', or 'D'
    });

    if (missing) {
      alert('Please answer all questions before submitting.');
      return;
    }

    const btn = document.getElementById('submit-btn');
    btn.disabled    = true;
    btn.textContent = 'Submitting…';

    // ── Score calculation (client-side) ──────────────
    let correct = 0;
    const answerDetail = [];

    cards.forEach(card => {
      const qid        = card.dataset.qid;
      const userAnswer = answers[qid];
      const rightAnswer= card.dataset.correct; // stored from GAS response

      const isCorrect = userAnswer === rightAnswer;
      if (isCorrect) correct++;

      answerDetail.push({
        question_id:    qid,
        user_answer:    userAnswer,
        correct_answer: rightAnswer,
        is_correct:     isCorrect,
      });
    });

    const total   = questions.length;
    const score   = Math.round((correct / total) * 100);
    const nowISO  = new Date().toISOString();

    // ── Build payload ────────────────────────────────
    const payload = {
      username: currentUser,
      date:     nowISO,
      score:    score,
      correct:  correct,
      total:    total,
      answers:  answerDetail,
    };

    // ── POST to GAS endpoint ─────────────────────────
    try {
      const endpoint = b64decode(config.endpoint_results);
      await fetch(endpoint, {
        method:  'POST',
        // GAS requires text/plain for CORS-free POST with no preflight
        headers: { 'Content-Type': 'text/plain' },
        body:    JSON.stringify(payload),
      });
    } catch (err) {
      // Non-fatal: show result even if save fails
      console.warn('Result save failed:', err);
    }

    showResult(score, correct, total);
  }

  /* ─────────────────────────────────────────────────────────
     STEP 6 — Show result page
     Displays the score ring, stats, and a success message.
  ───────────────────────────────────────────────────────── */
  function showResult(score, correct, total) {
    const PASS_THRESHOLD = 80; // percent
    const passed = score >= PASS_THRESHOLD;

    document.getElementById('result-username').textContent = currentUser;
    document.getElementById('result-score-num').textContent = score + '%';

    // Color ring green (pass) or red (fail)
    const ring = document.getElementById('result-ring');
    ring.classList.remove('pass', 'fail');
    ring.classList.add(passed ? 'pass' : 'fail');
    ring.style.setProperty('--score-pct', score + '%');

    // Title
    document.getElementById('result-title').textContent =
      passed ? 'Exam Passed! 🎉' : 'Exam Not Passed';

    // Verdict banner
    const verdictEl = document.getElementById('result-verdict');
    verdictEl.innerHTML = passed
      ? `<div class="verdict pass">✅ Congratulations, you passed the test!</div>`
      : `<div class="verdict fail">❌ Unfortunately, you did not pass the test, please try again!</div>`;

    // Subtitle
    document.getElementById('result-sub').textContent =
      `Passing score: ${PASS_THRESHOLD}% — Your answers have been recorded.`;

    // Stats
    document.getElementById('result-stats').innerHTML = `
      <div class="stat-pill"><strong>${score}%</strong>Your Score</div>
      <div class="stat-pill"><strong>${correct}</strong>Correct</div>
      <div class="stat-pill"><strong>${total - correct}</strong>Incorrect</div>
      <div class="stat-pill"><strong>${total}</strong>Total Qs</div>
    `;

    showView('result-view');
  }

  /* ─────────────────────────────────────────────────────────
     Logout — reset state and return to login
  ───────────────────────────────────────────────────────── */
  function logout() {
    currentUser = null;
    questions   = [];
    document.getElementById('username').value = '';
    document.getElementById('password').value = '';
    document.getElementById('login-btn').disabled    = false;
    document.getElementById('login-btn').textContent = 'Login';
    document.getElementById('login-error').classList.remove('visible');
    document.getElementById('questions-container').innerHTML = '';
    showView('login-view');
  }

  /* ─────────────────────────────────────────────────────────
     Utility: escape HTML to prevent XSS
  ───────────────────────────────────────────────────────── */
  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ── Bootstrap ────────────────────────────────── */
  document.addEventListener('DOMContentLoaded', init);

  /* ── Public API (called from HTML onclick attrs) ─ */
  return { login, submit, logout };

})();
