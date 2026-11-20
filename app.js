(function () {
'use strict';

/* ---------------- Python runner (Pyodide in a Web Worker) ---------------- */

// Where Pyodide (CPython for the browser) is loaded from. A page can override it,
// e.g. to serve a self-hosted copy: window.PYQUEST_PYODIDE_URL = 'pyodide/'
const PYODIDE_URL = window.PYQUEST_PYODIDE_URL
  ? new URL(window.PYQUEST_PYODIDE_URL, location.href).href
  : 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/';
const RUN_TIMEOUT_MS = 8000;

function workerMain() {
  const PRELUDE = String.raw`
import sys, io, re, linecache, traceback, contextlib

def _pq_register(src, fname):
    linecache.cache[fname] = (len(src), None, src.splitlines(True), fname)

def _pq_format(e, fname):
    if isinstance(e, SyntaxError):
        return ''.join(traceback.format_exception_only(type(e), e))
    frames = [f for f in traceback.extract_tb(e.__traceback__) if f.filename == fname]
    head = ('Traceback (most recent call last):\n' + ''.join(traceback.format_list(frames))) if frames else ''
    return head + ''.join(traceback.format_exception_only(type(e), e))

def _pq_new_ns():
    return {'__name__': '__main__'}

def _pq_exec(src, ns, fname='main.py'):
    _pq_register(src, fname)
    try:
        exec(compile(src, fname, 'exec'), ns)
    except SystemExit:
        pass
    except BaseException as e:
        return _pq_format(e, fname)
    finally:
        sys.stdout.flush()
        sys.stderr.flush()
    return None

def _pq_with(src, values):
    for k, v in values.items():
        src, n = re.subn(r'^' + re.escape(k) + r'\s*=.*$', k + ' = ' + repr(v), src, count=1, flags=re.M)
        if n == 0:
            raise AssertionError('Keep the line "' + k + ' = ..." in your code so it can be tested with other values.')
    ns = {'__name__': '__main__'}
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        exec(compile(src, 'main.py', 'exec'), ns)
    ns['_out'] = buf.getvalue()
    return ns

def _pq_check(tests, ns, src, out):
    ns['_out'] = out
    ns['_src'] = src
    ns['_ns_with'] = lambda **kw: _pq_with(src, kw)
    ns['_run_with'] = lambda **kw: _pq_with(src, kw)['_out']
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            exec(compile(tests, '<check>', 'exec'), ns)
    except AssertionError as e:
        return str(e) or 'One of the checks failed.'
    except NameError as e:
        return 'Your code doesn\'t define ' + repr(getattr(e, 'name', None) or str(e)) + ' yet. Check the name in the task.'
    except BaseException as e:
        return 'While checking, your code raised ' + type(e).__name__ + ': ' + str(e)
    return None
`;
  let py = null, fns = null;
  let out = '', truncated = false, stdinLines = [], stdinPos = 0;
  const LIMIT = 200000;
  const dec = new TextDecoder();
  const emit = (s) => { if (out.length < LIMIT) out += s; else truncated = true; };

  const ready = (async () => {
    importScripts(self.PYODIDE_URL + 'pyodide.js');
    py = await loadPyodide({ indexURL: self.PYODIDE_URL });
    const write = (buf) => { emit(dec.decode(buf, { stream: true })); return buf.length; };
    py.setStdout({ write });
    py.setStderr({ write });
    py.setStdin({
      stdin: () => {
        if (stdinPos < stdinLines.length) { const l = stdinLines[stdinPos++]; emit(l + '\n'); return l + '\n'; }
        return null;
      }
    });
    py.runPython(PRELUDE);
    fns = { exec: py.globals.get('_pq_exec'), check: py.globals.get('_pq_check'), ns: py.globals.get('_pq_new_ns') };
    self.postMessage({ type: 'ready' });
  })().catch((err) => self.postMessage({ type: 'fatal', error: String(err && err.message || err) }));

  self.onmessage = async (e) => {
    await ready;
    const { id, code, tests, stdin } = e.data;
    if (!fns) return;
    out = ''; truncated = false; stdinPos = 0;
    stdinLines = stdin ? String(stdin).replace(/\r/g, '').split('\n') : [];
    if (stdinLines.length && stdinLines[stdinLines.length - 1] === '') stdinLines.pop();
    const ns = fns.ns();
    try {
      const error = fns.exec(code, ns) || null;
      const runOut = out;
      let checked = false, message = null;
      if (!error && tests) {
        checked = true;
        message = fns.check(tests, ns, code, runOut) || null;
      }
      self.postMessage({ type: 'result', id, out: runOut, error, checked, passed: checked && !message, message, truncated });
    } catch (err) {
      self.postMessage({ type: 'result', id, out, error: String(err && err.message || err), checked: false, truncated });
    } finally {
      try { ns.destroy(); } catch (_) {}
    }
  };
}

const Runner = {
  worker: null, ready: false, failed: false, busy: false, seq: 0,
  waiters: [], pending: null, timer: null,
  start() {
    const src = 'self.PYODIDE_URL = ' + JSON.stringify(PYODIDE_URL) + ';\n(' + workerMain.toString() + ')();';
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    this.ready = false; this.failed = false;
    setStatus('loading');
    try { this.worker = new Worker(url); } catch (e) { this.fail(String(e)); return; }
    this.worker.onmessage = (e) => this.onMessage(e.data);
    this.worker.onerror = (e) => { e.preventDefault(); this.fail(e.message || 'Worker error'); };
  },
  fail(msg) {
    this.failed = true; this.ready = false;
    setStatus('error', msg);
    this.waiters.splice(0).forEach((w) => w.reject(new Error(msg)));
    if (this.pending) { this.finish({ error: 'Python could not load. Check your internet connection and reload the page.\n' + msg }); }
  },
  onMessage(m) {
    if (m.type === 'ready') { this.ready = true; setStatus('ready'); this.waiters.splice(0).forEach((w) => w.resolve()); }
    else if (m.type === 'fatal') this.fail(m.error);
    else if (m.type === 'result' && this.pending && m.id === this.pending.id) this.finish(m);
  },
  whenReady() {
    if (this.ready) return Promise.resolve();
    if (this.failed) { this.start(); }
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  },
  finish(result) {
    clearTimeout(this.timer);
    const p = this.pending; this.pending = null; this.busy = false;
    document.body.classList.remove('is-running');
    if (p) p.resolve(result);
  },
  async run(code, opts = {}) {
    if (this.busy) return null;
    this.busy = true;
    document.body.classList.add('is-running');
    try { await this.whenReady(); }
    catch (e) { this.busy = false; document.body.classList.remove('is-running'); return { error: 'Python could not load. Check your internet connection and reload the page.' }; }
    const id = ++this.seq;
    return new Promise((resolve) => {
      this.pending = { id, resolve };
      this.timer = setTimeout(() => {
        this.worker.terminate();
        this.finish({ error: 'Your code ran for more than ' + RUN_TIMEOUT_MS / 1000 + ' seconds, so PyQuest stopped it.\nIs there a loop that never ends? (e.g. a while loop whose condition never becomes False)', timedOut: true });
        this.start();
      }, RUN_TIMEOUT_MS);
      this.worker.postMessage({ id, code, tests: opts.tests || null, stdin: opts.stdin || '' });
    });
  }
};

/* ---------------- State ---------------- */

const KEY = 'pyquest-python-v1';
const defaults = () => ({ done: {}, code: {}, xp: 0, streak: 0, lastDay: null, play: null, playStdin: '', stdin: {} });
let state = defaults();
try { const raw = localStorage.getItem(KEY); if (raw) state = Object.assign(defaults(), JSON.parse(raw)); } catch (_) {}
let saveTimer = null;
function save(now) {
  clearTimeout(saveTimer);
  const doSave = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) {} };
  if (now) doSave(); else saveTimer = setTimeout(doSave, 300);
}

const COURSE = window.COURSE || [];
const ALL = [];
COURSE.forEach((m, mi) => m.lessons.forEach((l, li) => { l.module = m; l.mi = mi; l.li = li; l.index = ALL.length; ALL.push(l); }));
const byId = Object.fromEntries(ALL.map((l) => [l.id, l]));
const xpFor = (l) => (l.kind === 'challenge' ? 25 : 10);

const dayKey = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
function liveStreak() {
  if (!state.lastDay) return 0;
  const today = dayKey(new Date());
  const y = new Date(); y.setDate(y.getDate() - 1);
  return (state.lastDay === today || state.lastDay === dayKey(y)) ? state.streak : 0;
}
function bumpStreak() {
  const today = dayKey(new Date());
  if (state.lastDay === today) return;
  const y = new Date(); y.setDate(y.getDate() - 1);
  state.streak = state.lastDay === dayKey(y) ? state.streak + 1 : 1;
  state.lastDay = today;
}
const level = () => Math.floor(state.xp / 100) + 1;
const doneCount = () => ALL.filter((l) => state.done[l.id]).length;
const nextLesson = () => ALL.find((l) => !state.done[l.id]) || ALL[ALL.length - 1];

/* ---------------- Helpers ---------------- */

const $ = (sel, root = document) => root.querySelector(sel);

// Two-click confirmation (works where confirm() dialogs are blocked).
// First click arms the button and changes its label; a second click within 3s confirms.
function armed(btn, label) {
  if (btn.dataset.armed) { clearTimeout(+btn.dataset.armed); delete btn.dataset.armed; btn.textContent = btn.dataset.label; btn.classList.remove('is-armed'); return true; }
  btn.dataset.label = btn.textContent;
  btn.textContent = label;
  btn.classList.add('is-armed');
  btn.dataset.armed = String(setTimeout(() => { delete btn.dataset.armed; btn.textContent = btn.dataset.label; btn.classList.remove('is-armed'); }, 3000));
  return false;
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function dedent(s) {
  s = String(s || '').replace(/^\n+/, '').replace(/\s+$/, '');
  const ind = s.split('\n').filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length);
  const n = ind.length ? Math.min(...ind) : 0;
  return s.split('\n').map((l) => l.slice(n)).join('\n');
}
const codeText = (s) => dedent(s) + '\n';

function inline(t) {
  return t.split(/(~[^~\n]+~)/g).map((part) => {
    if (/^~[^~\n]+~$/.test(part)) return '<code>' + esc(part.slice(1, -1)) + '</code>';
    return esc(part).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  }).join('');
}

function highlight(code, el) {
  if (window.CodeMirror && CodeMirror.runMode) { el.textContent = ''; CodeMirror.runMode(code, 'python', el); }
  else el.textContent = code;
}

function renderMd(src, opts = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'prose';
  const lines = dedent(src).split('\n');
  let html = '', para = [], list = [], code = null, codeMeta = '';
  const blocks = [];
  const flush = () => {
    if (para.length) { html += '<p>' + inline(para.join(' ')) + '</p>'; para = []; }
    if (list.length) { html += '<ul>' + list.map((i) => '<li>' + inline(i) + '</li>').join('') + '</ul>'; list = []; }
  };
  for (const line of lines) {
    if (code !== null) {
      if (line.trim() === '~~~') { blocks.push({ code: code.join('\n'), meta: codeMeta }); html += '<div data-block="' + (blocks.length - 1) + '"></div>'; code = null; }
      else code.push(line);
      continue;
    }
    if (line.trim().startsWith('~~~')) { flush(); code = []; codeMeta = line.trim().slice(3).trim(); continue; }
    if (/^- /.test(line)) { if (para.length) { html += '<p>' + inline(para.join(' ')) + '</p>'; para = []; } list.push(line.slice(2)); continue; }
    if (/^### /.test(line)) { flush(); html += '<h3>' + inline(line.slice(4)) + '</h3>'; continue; }
    if (!line.trim()) { flush(); continue; }
    if (list.length && /^\s+\S/.test(line)) { list[list.length - 1] += ' ' + line.trim(); continue; }
    if (list.length) flush();
    para.push(line.trim());
  }
  flush();
  wrap.innerHTML = html;
  wrap.querySelectorAll('[data-block]').forEach((slot) => {
    const b = blocks[+slot.dataset.block];
    slot.replaceWith(exampleBlock(b.code, b.meta, opts));
  });
  return wrap;
}

function exampleBlock(code, meta, opts) {
  const box = document.createElement('div');
  box.className = 'example';
  const pre = document.createElement('pre');
  pre.className = 'cm-s-pq example-code';
  highlight(code, pre);
  box.appendChild(pre);
  if (/norun/.test(meta)) return box;
  const im = meta.match(/input:\s*(.*)$/);
  const stdin = im ? im[1].split('|').join('\n') : '';
  const bar = document.createElement('div');
  bar.className = 'example-bar';
  bar.innerHTML = '<button class="btn btn-small btn-ghost" data-act="run">' + ICON.play + 'Run</button>' +
    (opts.onTry ? '<button class="btn btn-small btn-ghost" data-act="try">Try in playground</button>' : '') +
    (stdin ? '<span class="example-note">Input: ' + esc(stdin.split('\n').join(', ')) + '</span>' : '');
  box.appendChild(bar);
  const outEl = document.createElement('pre');
  outEl.className = 'example-out';
  outEl.hidden = true;
  box.appendChild(outEl);
  bar.addEventListener('click', async (e) => {
    const btn = e.target.closest('button'); if (!btn) return;
    if (btn.dataset.act === 'try') { opts.onTry(code, stdin); return; }
    outEl.hidden = false; outEl.className = 'example-out'; outEl.textContent = Runner.ready ? 'Running…' : 'Starting Python… (first run takes a few seconds)';
    const r = await Runner.run(code, { stdin });
    if (!r) return;
    showOutput(outEl, r);
  });
  return box;
}

function showOutput(el, r) {
  el.textContent = '';
  if (r.out) el.appendChild(document.createTextNode(r.out));
  if (r.truncated) { const s = document.createElement('span'); s.className = 'muted'; s.textContent = '\n… output cut off (too long)\n'; el.appendChild(s); }
  if (r.error) { const s = document.createElement('span'); s.className = 'err'; s.textContent = (r.out && !r.out.endsWith('\n') ? '\n' : '') + r.error; el.appendChild(s); }
  if (!r.out && !r.error) { const s = document.createElement('span'); s.className = 'muted'; s.textContent = '(no output — use print() to see values)'; el.appendChild(s); }
}

const FRIENDLY = [
  [/^SyntaxError/m, 'Python couldn\'t understand a line. Look for a missing colon, bracket or quote near the line shown.'],
  [/^IndentationError/m, 'The spacing at the start of a line is off. Lines inside if/for/def need 4 spaces, and lines at the same level must line up.'],
  [/^NameError/m, 'You used a name Python doesn\'t know yet. Check the spelling, and make sure it\'s defined before you use it. Text needs quotes.'],
  [/^TypeError/m, 'An operation got the wrong kind of value, for example adding a number to a string. str() or int() can convert.'],
  [/^IndexError/m, 'You asked for a position that doesn\'t exist. Remember that indexes start at 0 and end at len - 1.'],
  [/^KeyError/m, 'That key isn\'t in the dictionary. Use .get(key, default) or check with "in" first.'],
  [/^ValueError/m, 'A function got a value it couldn\'t use, such as int("abc").'],
  [/^ZeroDivisionError/m, 'You divided by zero.'],
  [/^AttributeError/m, 'That object doesn\'t have the attribute or method you used. Check the spelling.'],
  [/^EOFError/m, 'input() was called but there was no more input. Add a line to the Input box for each input() call.'],
  [/^RecursionError/m, 'The function called itself too many times. Does it have a base case that stops it?'],
];
const friendly = (err) => { for (const [re, msg] of FRIENDLY) if (re.test(err)) return msg; return 'Read the last line of the error. It says what went wrong and on which line.'; };

const ICON = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5v14l12-7z" fill="currentColor"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13m-5-6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H6m5-6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z" fill="currentColor"/></svg>',
};

/* ---------------- Editor ---------------- */

function makeEditor(host, value, { onChange, onRun, onCheck } = {}) {
  if (window.CodeMirror) {
    const keys = {
      Tab: (cm) => cm.somethingSelected() ? cm.indentSelection('add') : cm.execCommand('insertSoftTab'),
      'Shift-Tab': 'indentLess',
      'Ctrl-Enter': () => onRun && onRun(), 'Cmd-Enter': () => onRun && onRun(),
      'Shift-Ctrl-Enter': () => onCheck && onCheck(), 'Shift-Cmd-Enter': () => onCheck && onCheck(),
      'Ctrl-/': 'toggleComment', 'Cmd-/': 'toggleComment',
    };
    const cm = CodeMirror(host, {
      value, mode: 'python', theme: 'pq', lineNumbers: true, indentUnit: 4, tabSize: 4, indentWithTabs: false,
      matchBrackets: true, autoCloseBrackets: true, viewportMargin: Infinity, extraKeys: keys,
      inputStyle: 'contenteditable', spellcheck: false, autocorrect: false, autocapitalize: false,
    });
    cm.on('change', () => onChange && onChange(cm.getValue()));
    setTimeout(() => cm.refresh(), 0);
    return { get: () => cm.getValue(), set: (v) => cm.setValue(v), focus: () => cm.focus() };
  }
  const ta = document.createElement('textarea');
  ta.className = 'fallback-editor'; ta.value = value; ta.spellcheck = false;
  ta.setAttribute('aria-label', 'Code editor');
  ta.addEventListener('input', () => onChange && onChange(ta.value));
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') { e.preventDefault(); const s = ta.selectionStart; ta.setRangeText('    ', s, ta.selectionEnd, 'end'); onChange && onChange(ta.value); }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); (e.shiftKey ? onCheck : onRun) && (e.shiftKey ? onCheck : onRun)(); }
  });
  host.appendChild(ta);
  return { get: () => ta.value, set: (v) => { ta.value = v; }, focus: () => ta.focus() };
}

/* ---------------- Shell: header, sidebar, status ---------------- */

function setStatus(kind, msg) {
  const el = $('#py-status'); if (!el) return;
  el.dataset.state = kind;
  el.querySelector('span').textContent = kind === 'ready' ? 'Python ready' : kind === 'loading' ? 'Loading Python…' : 'Python failed to load';
  el.title = kind === 'error' ? (msg || '') + ' — click to retry' : '';
}

function renderStats() {
  $('#stat-xp').textContent = state.xp;
  $('#stat-level').textContent = level();
  $('#stat-streak').textContent = liveStreak();
}

function renderSidebar(currentId) {
  const nav = $('#lesson-nav');
  const done = doneCount();
  let html = '<div class="side-progress"><div class="side-progress-top"><span>Course progress</span><span>' + done + ' / ' + ALL.length + '</span></div>' +
    '<div class="bar"><i style="width:' + (done / ALL.length * 100).toFixed(1) + '%"></i></div></div>';
  html += '<a class="side-link' + (currentId === '#play' ? ' is-current' : '') + '" href="#play"><span class="dot dot-play"></span>Playground</a>';
  COURSE.forEach((m, mi) => {
    const mdone = m.lessons.filter((l) => state.done[l.id]).length;
    html += '<div class="side-module"><div class="side-module-title"><span>' + (mi + 1) + '. ' + esc(m.title) + '</span><span class="muted">' + mdone + '/' + m.lessons.length + '</span></div>';
    m.lessons.forEach((l) => {
      const cls = ['side-link'];
      if (l.id === currentId) cls.push('is-current');
      if (state.done[l.id]) cls.push('is-done');
      html += '<a class="' + cls.join(' ') + '" href="#lesson-' + l.id + '"' + (l.id === currentId ? ' aria-current="page"' : '') + '>' +
        '<span class="dot">' + (state.done[l.id] ? ICON.check : '') + '</span>' + esc(l.title) +
        (l.kind === 'challenge' ? '<span class="tag">challenge</span>' : '') + '</a>';
    });
    html += '</div>';
  });
  nav.innerHTML = html;
  const cur = nav.querySelector('.is-current');
  if (cur && !isVisibleIn(cur, nav)) cur.scrollIntoView({ block: 'center' });
}
const isVisibleIn = (el, box) => { const a = el.getBoundingClientRect(), b = box.getBoundingClientRect(); return a.top >= b.top && a.bottom <= b.bottom; };

/* ---------------- Views ---------------- */

const main = () => $('#main');

function viewHome() {
  renderSidebar(null);
  const done = doneCount();
  const nxt = nextLesson();
  const el = document.createElement('div');
  el.className = 'home';
  el.innerHTML = `
    <section class="hero">
      <div>
        <p class="eyebrow">Free · No sign-up · Runs in your browser</p>
        <h1>Learn Python by <em>writing</em> Python.</h1>
        <p class="lede">${ALL.length} short lessons take you from <code>print()</code> to classes. You write real code in every lesson, and PyQuest checks it straight away.</p>
        <div class="hero-actions">
          <a class="btn btn-primary btn-big" href="#lesson-${nxt.id}">${done ? 'Continue: ' + esc(nxt.title) : 'Start the first lesson'} ${ICON.arrow}</a>
          <a class="btn btn-ghost btn-big" href="#play">Open playground</a>
        </div>
      </div>
      <div class="hero-card" aria-hidden="true">
        <div class="hero-card-bar"><i></i><i></i><i></i><span>main.py</span></div>
        <pre class="cm-s-pq" id="hero-code"></pre>
        <div class="hero-card-out">Hello, Ada! You have 3 new badges.</div>
      </div>
    </section>
    <section class="stats" aria-label="Your progress">
      <div class="stat"><b>${done}<small>/${ALL.length}</small></b><span>lessons done</span></div>
      <div class="stat"><b>${state.xp}</b><span>XP earned</span></div>
      <div class="stat"><b>${level()}</b><span>level</span></div>
      <div class="stat"><b>${liveStreak()}</b><span>day streak</span></div>
    </section>
    <h2 class="section-title">The path</h2>
    <section class="modules"></section>
    <section class="how">
      <div><span class="how-n">1</span><h3>Read a short idea</h3><p>Each lesson explains one concept, with examples you can run and change.</p></div>
      <div><span class="how-n">2</span><h3>Write the code</h3><p>Solve a small task in a real Python editor. Press Ctrl+Enter to run it.</p></div>
      <div><span class="how-n">3</span><h3>Get instant feedback</h3><p>Press Check to test your answer. You get hints when something's off, and XP when it's right.</p></div>
    </section>
    <a class="next-course" href="ai-course/">
      <div>
        <p class="eyebrow">After PyQuest</p>
        <h3>AI Engineer Foundations</h3>
        <p>A free 56-day course, one hour a day. It covers the command line, Git, Docker, SQL, APIs, NumPy, pandas and the math behind machine learning.</p>
      </div>
      <span class="btn btn-ghost">Open the course ${ICON.arrow}</span>
    </a>
    <footer class="foot">
      <p>Your code runs on your own device using <a href="https://pyodide.org" target="_blank" rel="noopener">Pyodide</a>, which is real CPython compiled for the browser. Your progress is saved in this browser only.</p>
      <button class="link-btn" id="reset-progress">Reset progress</button>
    </footer>`;
  const grid = el.querySelector('.modules');
  COURSE.forEach((m, mi) => {
    const mdone = m.lessons.filter((l) => state.done[l.id]).length;
    const first = m.lessons.find((l) => !state.done[l.id]) || m.lessons[0];
    const a = document.createElement('a');
    a.className = 'module-card' + (mdone === m.lessons.length ? ' is-complete' : '');
    a.href = '#lesson-' + first.id;
    a.innerHTML = `<span class="module-num">${String(mi + 1).padStart(2, '0')}</span>
      <h3>${esc(m.title)}</h3><p>${esc(m.blurb)}</p>
      <div class="module-foot"><div class="bar"><i style="width:${(mdone / m.lessons.length * 100).toFixed(0)}%"></i></div><span>${mdone}/${m.lessons.length}</span></div>`;
    grid.appendChild(a);
  });
  main().replaceChildren(el);
  highlight('name = "Ada"\nbadges = ["loops", "lists", "functions"]\n\nprint(f"Hello, {name}! You have {len(badges)} new badges.")', $('#hero-code'));
  $('#reset-progress').addEventListener('click', (e) => {
    if (armed(e.currentTarget, 'Click again to erase all progress')) { state = defaults(); save(true); renderStats(); route(); }
  });
  document.title = 'PyQuest · Learn Python free';
}

function viewLesson(id) {
  const l = byId[id];
  if (!l) { location.hash = ''; return; }
  renderSidebar(l.id);
  const next = ALL[l.index + 1];
  const el = document.createElement('article');
  el.className = 'lesson';
  el.innerHTML = `
    <div class="lesson-text">
      <p class="crumb">Module ${l.mi + 1} · ${esc(l.module.title)} <span>Lesson ${l.li + 1} of ${l.module.lessons.length}</span></p>
      <h1>${esc(l.title)} ${l.kind === 'challenge' ? '<span class="tag tag-big">challenge · 25 XP</span>' : ''}</h1>
      <div class="lesson-body"></div>
    </div>
    <section class="work" aria-label="Exercise">
      <div class="task">
        <h2>${state.done[l.id] ? '<span class="done-pill">' + ICON.check + 'Completed</span>' : 'Your task'}</h2>
        <div class="task-body"></div>
      </div>
      <div class="editor-card">
        <div class="editor-bar"><span class="file">main.py</span><span class="kbd-hint">Ctrl+Enter run · Ctrl+Shift+Enter check</span><button class="link-btn" data-act="reset">Reset code</button></div>
        <div class="editor-host"></div>
        ${l.stdin ? '<div class="stdin-row"><label>Input <small>(the checker types this)</small></label><div class="stdin-fixed">' + esc(l.stdin) + '</div></div>' : ''}
        <div class="actions">
          <button class="btn btn-ghost" data-act="run">${ICON.play}Run</button>
          <button class="btn btn-primary" data-act="check">${ICON.check}Check answer</button>
          <span class="spacer"></span>
          <button class="link-btn" data-act="hint">Hint</button>
          <button class="link-btn" data-act="solution">Show solution</button>
        </div>
      </div>
      <div class="result" role="status" aria-live="polite" hidden></div>
      <div class="hint-box" hidden></div>
      <div class="solution-box" hidden></div>
      <div class="console"><div class="console-bar">Output</div><pre class="console-out"><span class="muted">Run your code to see output here.</span></pre></div>
    </section>`;
  const onTry = (code, stdin) => { state.play = code + '\n'; state.playStdin = stdin; save(true); location.hash = '#play'; };
  el.querySelector('.lesson-body').appendChild(renderMd(l.body, { onTry }));
  el.querySelector('.task-body').appendChild(renderMd(l.task));
  main().replaceChildren(el);
  window.scrollTo(0, 0);
  main().scrollTop = 0;

  const outEl = el.querySelector('.console-out');
  const resEl = el.querySelector('.result');
  const hintEl = el.querySelector('.hint-box');
  const solEl = el.querySelector('.solution-box');
  let fails = 0;

  const editor = makeEditor(el.querySelector('.editor-host'), state.code[l.id] != null ? state.code[l.id] : codeText(l.starter), {
    onChange: (v) => { state.code[l.id] = v; save(); },
    onRun: () => doRun(false),
    onCheck: () => doRun(true),
  });

  async function doRun(check) {
    if (Runner.busy) return;
    resEl.hidden = true;
    outEl.innerHTML = '<span class="muted">' + (Runner.ready ? 'Running…' : 'Starting Python… the first run takes a few seconds.') + '</span>';
    const r = await Runner.run(editor.get(), { tests: check ? dedent(l.tests) : null, stdin: l.stdin || '' });
    if (!r) return;
    showOutput(outEl, r);
    if (r.error) {
      showResult('error', r.timedOut ? 'Stopped: took too long' : 'Your code raised an error', r.timedOut ? 'Check your loops. Each loop needs a way to end.' : friendly(r.error));
      if (check) fails++;
    } else if (check && r.passed) {
      const first = !state.done[l.id];
      if (first) { state.done[l.id] = true; state.xp += xpFor(l); bumpStreak(); save(true); renderStats(); renderSidebar(l.id); }
      const modDone = l.module.lessons.every((x) => state.done[x.id]);
      showResult('pass', first ? 'Correct! +' + xpFor(l) + ' XP' : 'Correct!',
        modDone && first && l.li === l.module.lessons.length - 1 ? 'You finished the "' + l.module.title + '" module.' : (next ? 'Ready for the next lesson?' : 'You finished the whole course. Amazing work!'), true);
      el.querySelector('.task h2').innerHTML = '<span class="done-pill">' + ICON.check + 'Completed</span>';
    } else if (check) {
      fails++;
      showResult('fail', 'Not quite yet', r.message + (fails >= 2 && hintEl.hidden ? '\nStuck? Try the hint.' : ''));
    }
  }

  function showResult(kind, title, msg, withNext) {
    resEl.hidden = false;
    resEl.className = 'result result-' + kind;
    resEl.innerHTML = '<div><strong>' + esc(title) + '</strong><p>' + esc(msg).replace(/\n/g, '<br>') + '</p></div>' +
      (withNext ? (next ? '<a class="btn btn-primary" href="#lesson-' + next.id + '">Next lesson ' + ICON.arrow + '</a>' : '<a class="btn btn-primary" href="#">Home ' + ICON.arrow + '</a>') : '');
    if (kind === 'pass') { resEl.classList.remove('pop'); void resEl.offsetWidth; resEl.classList.add('pop'); }
  }

  el.querySelector('.work').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const act = b.dataset.act;
    if (act === 'run') doRun(false);
    else if (act === 'check') doRun(true);
    else if (act === 'reset') { if (armed(b, 'Click again to reset')) { editor.set(codeText(l.starter)); delete state.code[l.id]; save(); } }
    else if (act === 'hint') { hintEl.hidden = false; hintEl.innerHTML = '<strong>Hint</strong><p>' + esc(l.hint) + '</p>'; }
    else if (act === 'solution') {
      if (solEl.hidden && !state.done[l.id] && fails < 1 && !armed(b, 'Try first? Click again to show')) return;
      solEl.hidden = !solEl.hidden;
      if (!solEl.hidden) {
        solEl.innerHTML = '<div class="solution-top"><strong>One possible solution</strong><button class="link-btn" data-act="use-solution">Copy into editor</button></div>';
        const pre = document.createElement('pre'); pre.className = 'cm-s-pq'; highlight(codeText(l.solution), pre); solEl.appendChild(pre);
      }
    } else if (act === 'use-solution') { editor.set(codeText(l.solution)); }
  });
  document.title = l.title + ' · PyQuest';
}

function viewPlay() {
  renderSidebar('#play');
  const el = document.createElement('div');
  el.className = 'play';
  el.innerHTML = `
    <div class="play-head">
      <div><h1>Playground</h1><p class="muted">Write any Python you like. Your code is saved automatically. Press Ctrl+Enter to run.</p></div>
      <div class="play-actions">
        <button class="btn btn-ghost" data-act="clear">Clear</button>
        <button class="btn btn-primary" data-act="run">${ICON.play}Run</button>
      </div>
    </div>
    <div class="play-grid">
      <div class="editor-card"><div class="editor-bar"><span class="file">playground.py</span></div><div class="editor-host"></div></div>
      <div class="play-side">
        <div class="stdin-card"><label for="play-stdin">Input <small>(one line per input() call)</small></label><textarea id="play-stdin" rows="3" spellcheck="false" placeholder="Ada&#10;42"></textarea></div>
        <div class="console"><div class="console-bar">Output</div><pre class="console-out"><span class="muted">Output appears here.</span></pre></div>
      </div>
    </div>`;
  main().replaceChildren(el);
  const stdinEl = el.querySelector('#play-stdin');
  stdinEl.value = state.playStdin || '';
  stdinEl.addEventListener('input', () => { state.playStdin = stdinEl.value; save(); });
  const outEl = el.querySelector('.console-out');
  const starter = '# Try anything here!\nimport random\n\nname = input("Your name: ")\nlucky = random.randint(1, 100)\nprint(f"Hi {name}, your lucky number is {lucky}")\n';
  const run = async () => {
    outEl.innerHTML = '<span class="muted">' + (Runner.ready ? 'Running…' : 'Starting Python…') + '</span>';
    const r = await Runner.run(editor.get(), { stdin: stdinEl.value });
    if (r) showOutput(outEl, r);
  };
  const editor = makeEditor(el.querySelector('.editor-host'), state.play != null ? state.play : starter, {
    onChange: (v) => { state.play = v; save(); }, onRun: run,
  });
  if (state.play == null && !state.playStdin) { stdinEl.value = 'Ada'; state.playStdin = 'Ada'; }
  el.querySelector('.play-actions').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    if (b.dataset.act === 'run') run();
    if (b.dataset.act === 'clear') outEl.innerHTML = '<span class="muted">Output appears here.</span>';
  });
  document.title = 'Playground · PyQuest';
}

/* ---------------- Router & boot ---------------- */

function route() {
  document.body.classList.remove('nav-open');
  const h = location.hash.replace(/^#/, '');
  if (h.startsWith('lesson-')) viewLesson(h.slice(7));
  else if (h === 'play') viewPlay();
  else viewHome();
}

function initTheme() {
  let t = null;
  try { t = localStorage.getItem('pyquest-theme'); } catch (_) {}
  if (t) document.documentElement.dataset.theme = t;
  $('#theme-btn').addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const nt = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = nt;
    try { localStorage.setItem('pyquest-theme', nt); } catch (_) {}
  });
}

window.addEventListener('hashchange', route);
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  $('#menu-btn').addEventListener('click', () => document.body.classList.toggle('nav-open'));
  $('#scrim').addEventListener('click', () => document.body.classList.remove('nav-open'));
  $('#py-status').addEventListener('click', () => { if (Runner.failed) Runner.start(); });
  renderStats();
  route();
  Runner.start();
});
window.addEventListener('beforeunload', () => save(true));
})();
