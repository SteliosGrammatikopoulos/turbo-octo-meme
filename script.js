/* ============================================================================
   ΦΩΝΗΤΙΚΗ ΠΛΗΚΤΡΟΛΟΓΗΣΗ ΓΙΑ GOOGLE DOCS — script.js
   ----------------------------------------------------------------------------
   • Φορτώνεται από το GitHub repo: SteliosGrammatikopoulos/drfgbhdxfb-fxd
     (μέσω fetch-loader στο index.html — raw + jsDelivr fallback).
   • Αναγνώριση ομιλίας με το Web Speech API (Chrome / Edge)
     https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API
   • Γλώσσα: Ελληνικά (el-GR) — επιλέξιμες και άλλες
   • Αυτόματη επανεκκίνηση, διαχείριση αδειών μικροφώνου, φωνητικές εντολές
   • Αποστολή του κειμένου στο Google Doc:
       α) μέσω google.script.run όταν η σελίδα σερβίρεται από Apps Script, ή
       β) μέσω fetch (POST) στο URL Web App του Apps Script, ή
       γ) απλή αντιγραφή στο πρόχειρο για επικόλληση με Ctrl+V
   ============================================================================ */
(function () {
  'use strict';

  /* Προστασία από διπλή φόρτωση (τοπικό script.js + include του Apps Script) */
  if (window.__VD_LOADED) return;
  window.__VD_LOADED = true;

  /* ============================ ΡΥΘΜΙΣΕΙΣ ============================ */
  var CONFIG = {
    /* Το ID του Google Doc — πάρθηκε από το URL του εγγράφου σας */
    DOC_ID: '1sGCFAKr0Le4mc0KPCgNyo9GbYa0OIL1EV0b45H_GT2E',

    DEFAULT_LANG: 'el-GR',        // προεπιλεγμένη γλώσσα αναγνώρισης
    AUTO_SEND_SILENCE_MS: 6000,   // ms σιωπής πριν την αυτόματη αποστολή
    RETRY_DELAY_MS: 400,          // καθυστέρηση επανεκκίνησης αναγνώρισης
    MAX_START_RETRIES: 3          // μέγιστες προσπάθειες εκκίνησης
  };

  /* ============================ ΠΕΡΙΒΑΛΛΟΝ ============================ */
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;

  /* Ασφαλές storage — αν το localStorage είναι μπλοκαρισμένο (π.χ. μέσα στο
     iframe του Apps Script όταν τα third-party cookies είναι αποκλεισμένα),
     η σελίδα ΔΕΝ κρασάρει: πέφτει σε in-memory αποθήκευση για τη συνεδρία. */
  var store = (function () {
    var ls = null, mem = {};
    try {
      ls = window.localStorage;
      ls.setItem('__vd_test', '1');
      ls.removeItem('__vd_test');
    } catch (e) { ls = null; }
    return {
      get: function (k) {
        try { if (ls) return ls.getItem(k); } catch (e) { /* ignore */ }
        return (k in mem) ? mem[k] : null;
      },
      set: function (k, v) {
        try { if (ls) { ls.setItem(k, v); return; } } catch (e) { /* ignore */ }
        mem[k] = v;
      }
    };
  })();
  var HAS_GSR = (typeof google !== 'undefined' && google.script && google.script.run);

  /* Φωνητικές εντολές: [όρος, αντικατάσταση] — χωρίς \b γιατί δεν ισχύει για ελληνικά */
  var COMMAND_WORDS = [
    ['νέα παράγραφος', '\n\n'],
    ['νέα γραμμή',     '\n'],
    ['σημείο',         '.'],
    ['κόμμα',          ','],
    ['ερωτηματικό',    ';'],   // ελληνικό ερωτηματικό
    ['θαυμαστικό',     '!'],
    ['άνω τελεία',     '·']
  ];
  var CLEAR_RE = /^\s*(διαγραφή όλων|σβήσε όλα|καθαρισμός όλων)\s*[.!?;]*\s*$/i;

  /* ============================ ΚΑΤΑΣΤΑΣΗ ============================ */
  var state = {
    listening: false,       // ακούει αυτή τη στιγμή;
    shouldRestart: false,   // να επανεκκινηθεί όταν σταματήσει μόνο του;
    rec: null,              // το αντικείμενο SpeechRecognition
    startRetries: 0,
    sendTimer: null,        // timer αυτόματης αποστολής
    lastUnconfigWarn: 0     // throttle προειδοποίησης "δεν έχει ρυθμιστεί URL"
  };

  var els = {};
  var IDS = ['statusBadge', 'micBtn', 'langSel', 'settingsBtn', 'autoSend',
             'useCommands', 'clearAfterSend', 'interim', 'transcript', 'counter',
             'sendBtn', 'copyBtn', 'clearBtn', 'settings', 'webappUrl',
             'saveUrlBtn', 'testBtn', 'docFrame', 'refreshBtn', 'editLink', 'toasts'];

  function $(id) { return document.getElementById(id); }

  /* ============================ ΑΡΧΙΚΟΠΟΙΗΣΗ ============================ */
  function init() {
    IDS.forEach(function (id) { els[id] = $(id); });

    /* Το έγγραφο: /preview (επιτρέπεται σε iframe) + σύνδεσμος /edit */
    var base = 'https://docs.google.com/document/d/' + CONFIG.DOC_ID;
    els.docFrame.src = base + '/preview';
    els.editLink.href = base + '/edit';

    /* Επαναφορά αποθηκευμένων ρυθμίσεων */
    els.webappUrl.value = store.get('vd_webapp_url') || '';
    var savedLang = store.get('vd_lang');
    if (savedLang) els.langSel.value = savedLang;
    els.autoSend.checked      = store.get('vd_autosend') !== '0';
    els.useCommands.checked   = store.get('vd_commands') !== '0';
    els.clearAfterSend.checked = store.get('vd_clear') !== '0';

    /* Έλεγχος υποστήριξης browser & ασφαλούς περιβάλλοντος */
    if (!SR) {
      els.micBtn.disabled = true;
      els.micBtn.title = 'Μη υποστηριζόμενο πρόγραμμα περιήγησης';
      setStatus('err', 'Μη διαθέσιμο');
      toast('Αυτός ο browser δεν υποστηρίζει το Web Speech API.\nΧρησιμοποιήστε Chrome ή Edge.', 'err', 12000);
    } else if (!window.isSecureContext) {
      toast('Η άδεια μικροφώνου απαιτεί HTTPS ή localhost.\nΗ αναγνώριση ενδέχεται να μη λειτουργήσει σε αυτή τη διεύθυνση.', 'warn', 12000);
    }

    bind();
    updateCounter();
  }

  function bind() {
    els.micBtn.addEventListener('click', toggleListening);
    els.sendBtn.addEventListener('click', sendToDoc);
    els.copyBtn.addEventListener('click', copyText);
    els.clearBtn.addEventListener('click', clearAll);
    els.refreshBtn.addEventListener('click', refreshDoc);
    els.settingsBtn.addEventListener('click', function () {
      els.settings.classList.toggle('open');
    });
    els.saveUrlBtn.addEventListener('click', saveUrl);
    els.testBtn.addEventListener('click', testConnection);
    els.transcript.addEventListener('input', updateCounter);

    els.langSel.addEventListener('change', function () {
      store.set('vd_lang', els.langSel.value);
      if (state.listening && state.rec) {
        /* Το onend θα κάνει αυτόματη επανεκκίνηση με τη νέα γλώσσα */
        try { state.rec.stop(); } catch (e) { /* αγνόησε */ }
      }
    });

    [els.autoSend, els.useCommands, els.clearAfterSend].forEach(function (cb) {
      cb.addEventListener('change', persistSwitches);
    });
  }

  /* ==================== ΑΝΑΓΝΩΡΙΣΗ ΟΜΙΛΙΑΣ (Web Speech API) ==================== */

  function toggleListening() {
    if (!SR) return;
    if (state.listening) { stopListening(); } else { startListening(); }
  }

  function startListening() {
    state.shouldRestart = true;
    state.startRetries = 0;
    createAndStart();
    /* Οδηγία αδείας μόνο την πρώτη φορά */
    if (!store.get('vd_perm_hint')) {
      toast('Όταν ο browser ζητήσει άδεια μικροφώνου, πατήστε «Να επιτρέπεται».', 'info', 7000);
      store.set('vd_perm_hint', '1');
    }
  }

  function createAndStart() {
    try {
      state.rec = new SR();
      state.rec.lang          = els.langSel.value || CONFIG.DEFAULT_LANG;
      state.rec.continuous    = true;    // συνεχής ακρόαση
      state.rec.interimResults = true;   // ζωντανά προσχέδια κειμένου
      state.rec.maxAlternatives = 1;

      state.rec.onstart = function () {
        state.listening = true;
        setStatus('listen', 'Ακούω…');
        els.micBtn.classList.add('on');
        els.micBtn.textContent = '⏹';
      };
      state.rec.onresult = onResult;
      state.rec.onerror  = onError;
      state.rec.onend    = onEnd;

      state.rec.start();
    } catch (e) {
      /* π.χ. ήδη ξεκίνησε — δοκίμασε ξανά λίγο αργότερα */
      if (state.shouldRestart && state.startRetries < CONFIG.MAX_START_RETRIES) {
        state.startRetries++;
        setTimeout(createAndStart, CONFIG.RETRY_DELAY_MS);
      } else {
        state.shouldRestart = false;
        setStatus('err', 'Σφάλμα');
        toast('Δεν μπόρεσε να ξεκινήσει η αναγνώριση: ' + (e.message || e), 'err', 8000);
      }
    }
  }

  function stopListening() {
    state.shouldRestart = false;
    state.listening = false;
    try { if (state.rec) state.rec.stop(); } catch (e) { /* αγνόησε */ }
    setStatus('', 'Έτοιμο');
    els.micBtn.classList.remove('on');
    els.micBtn.textContent = '🎤';
    showInterim('');
  }

  function onEnd() {
    showInterim('');
    /* Το Chrome σταματά μόνο του μετά από παύση ή δικτυακό πρόβλημα:
       επανεκκινούμε αυτόματα, όσο ο χρήστης θέλει να ακούει. */
    if (state.shouldRestart) {
      setTimeout(function () {
        if (state.shouldRestart) createAndStart();
      }, CONFIG.RETRY_DELAY_MS);
    }
  }

  function onError(e) {
    /* Ασήμαντα: το onend αναλαμβάνει την επανεκκίνηση */
    if (e.error === 'no-speech' || e.error === 'aborted') return;

    state.shouldRestart = false;
    state.listening = false;
    els.micBtn.classList.remove('on');
    els.micBtn.textContent = '🎤';

    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      setStatus('err', 'Χωρίς άδεια');
      toast('Δεν δόθηκε άδεια μικροφώνου.\n\nΚάντε κλικ στο εικονίδιο δίπλα στη διεύθυνση της σελίδας → «Μικρόφωνο» → «Να επιτρέπεται» και μετά ανανεώστε τη σελίδα.', 'err', 15000);
    } else if (e.error === 'audio-capture') {
      setStatus('err', 'Κανένα μικρόφωνο');
      toast('Δεν εντοπίστηκε μικρόφωνο. Ελέγξτε ότι είναι συνδεδεμένο/επιλεγμένο και ότι δεν το χρησιμοποιεί άλλη εφαρμογή.', 'err', 10000);
    } else if (e.error === 'network') {
      setStatus('err', 'Δίκτυο');
      toast('Πρόβλημα δικτύου με την υπηρεσία αναγνώρισης. Ελέγξτε τη σύνδεσή σας και δοκιμάστε ξανά.', 'err', 10000);
    } else {
      setStatus('err', 'Σφάλμα');
      toast('Σφάλμα αναγνώρισης: ' + e.error, 'err', 8000);
    }
  }

  function onResult(event) {
    var interim = '';
    for (var i = event.resultIndex; i < event.results.length; i++) {
      var res = event.results[i];
      if (res.isFinal) {
        handleFinal(res[0].transcript);
      } else {
        interim += res[0].transcript;
      }
    }
    showInterim(interim);
  }

  /* ==================== ΕΠΕΞΕΡΓΑΣΙΑ ΤΕΛΙΚΟΥ ΚΕΙΜΕΝΟΥ ==================== */

  function handleFinal(raw) {
    var text = (raw || '').trim();
    if (!text) return;

    if (els.useCommands.checked) {
      if (CLEAR_RE.test(text)) {
        clearAll();
        toast('🧹 «Διαγραφή όλων» — καθάρισε το κείμενο.', 'info');
        return;
      }
      text = applyCommands(text);
    }
    text = capitalizeSentences(text);
    if (!text) return;

    var ta = els.transcript;
    var needSpace = ta.value.length > 0 && !/[\n\s]$/.test(ta.value);
    ta.value += (needSpace ? ' ' : '') + text;
    updateCounter();
    ta.scrollTop = ta.scrollHeight;

    scheduleAutoSend();
  }

  /* Αντικατάσταση φωνητικών εντολών (ασφαλές για ελληνικά, χωρίς \b) */
  function applyCommands(text) {
    COMMAND_WORDS.forEach(function (c) {
      var re = new RegExp('(^|[\\s.,;!·])' + c[0] + '(?=$|[\\s.,;!·])', 'gi');
      text = text.replace(re, function (m, p) { return p + c[1]; });
    });
    text = text.replace(/[ \t]+([.,;!·])/g, '$1');  // κενό πριν από σημείο
    text = text.replace(/\n[ \t]+/g, '\n');          // κενά μετά από αλλαγή γραμμής
    text = text.replace(/ {2,}/g, ' ');              // διπλά κενά
    return text.trim();
  }

  /* Κεφαλαίο στην αρχή προτάσεων */
  function capitalizeSentences(text) {
    try {
      return text.replace(/(^|[.!?…]\s*|\n+)([\p{L}])/gu, function (m, p, c) {
        return p + c.toUpperCase();
      });
    } catch (e) {
      return text.charAt(0).toUpperCase() + text.slice(1);
    }
  }

  function showInterim(t) {
    els.interim.textContent = t ? ('… ' + t) : '';
  }

  /* ==================== ΑΥΤΟΜΑΤΗ ΑΠΟΣΤΟΛΗ ΜΕΤΑ ΤΗ ΣΙΩΠΗ ==================== */

  function scheduleAutoSend() {
    if (!els.autoSend.checked) return;
    clearTimeout(state.sendTimer);
    state.sendTimer = setTimeout(function () {
      if (els.transcript.value.trim()) sendToDoc();
    }, CONFIG.AUTO_SEND_SILENCE_MS);
  }

  /* ==================== ΑΠΟΣΤΟΛΗ ΣΤΟ ΕΓΓΡΑΦΟ ==================== */

  function sendToDoc() {
    var text = (els.transcript.value || '').trim();
    if (!text) { toast('Δεν υπάρχει κείμενο προς αποστολή.', 'warn'); return; }
    clearTimeout(state.sendTimer);

    /* α) Μέσα από Apps Script (google.script.run) — χωρίς CORS, χωρίς URL */
    if (HAS_GSR) {
      setStatus('ok', 'Αποστολή…');
      google.script.run
        .withSuccessHandler(function (res) { onSent(res); })
        .withFailureHandler(function (err) { onSendError(err && err.message ? err.message : String(err)); })
        .appendToDoc(text);
      return;
    }

    /* β) Fetch POST στο URL Web App του Apps Script */
    var url = (els.webappUrl.value || '').trim();
    if (!url) {
      els.settings.classList.add('open');
      maybeWarnUnconfigured();
      return;
    }

    setStatus('ok', 'Αποστολή…');
    /* Content-Type: text/plain → «απλό» αίτημα, χωρίς CORS preflight */
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ text: text, docId: CONFIG.DOC_ID })
    })
      .then(function (r) { return r.text(); })
      .then(function (raw) {
        var data = null;
        try { data = JSON.parse(raw); } catch (e) { /* όχι JSON */ }
        if (!data) {
          throw new Error('Μη αναμενόμενη απάντηση. Ελέγξτε ότι το URL τελειώνει σε /exec, ότι η πρόσβαση είναι «Όλοι» και ότι έγινε ανάπτυξη ΝΕΑΣ έκδοσης.');
        }
        if (!data.ok) throw new Error(data.error || 'Άγνωστο σφάλμα στο Apps Script.');
        onSent(data);
      })
      .catch(function (err) { onSendError(err.message || String(err)); });
  }

  function onSent() {
    setStatus('', 'Έτοιμο');
    toast('✔ Το κείμενο στάλθηκε στο έγγραφο.', 'ok');
    if (els.clearAfterSend.checked) {
      els.transcript.value = '';
      updateCounter();
    }
    /* Η προεπισκόπηση ενημερώνεται με μικρή καθυστέρηση από την Google */
    setTimeout(refreshDoc, 2500);
  }

  function onSendError(msgText) {
    setStatus('err', 'Αποτυχία');
    toast('❌ Αποτυχία αποστολής: ' + msgText, 'err', 12000);
  }

  function maybeWarnUnconfigured() {
    var now = Date.now();
    if (now - state.lastUnconfigWarn > 30000) {
      state.lastUnconfigWarn = now;
      toast('Για αυτόματη αποστολή, ρυθμίστε το URL του Apps Script στα «⚙ Ρυθμίσεις».\nΕναλλακτικά: 📋 Αντιγραφή και επικόλληση στο έγγραφο.', 'warn', 10000);
      els.autoSend.checked = false;   // σταματούν οι επαναλαμβανόμενες προσπάθειες
      persistSwitches();
    }
  }

  /* ==================== ΔΟΚΙΜΗ ΣΥΝΔΕΣΗΣ ==================== */

  function testConnection() {
    if (HAS_GSR) {
      google.script.run
        .withSuccessHandler(function (res) {
          if (res && res.ok) toast('✔ Η σύνδεση με το έγγραφο λειτουργεί!', 'ok', 8000);
          else toast('⚠ Απάντηση: ' + JSON.stringify(res), 'warn', 10000);
        })
        .withFailureHandler(function (err) {
          toast('❌ ' + (err && err.message ? err.message : err), 'err', 10000);
        })
        .appendToDoc('— Δοκιμή σύνδεσης —');
      return;
    }

    var url = (els.webappUrl.value || '').trim();
    if (!url) {
      els.settings.classList.add('open');
      toast('Συμπληρώστε πρώτα το URL του Web App.', 'warn');
      return;
    }
    toast('Δοκιμή σύνδεσης…', 'info', 2500);
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ text: '— Δοκιμή σύνδεσης —', docId: CONFIG.DOC_ID })
    })
      .then(function (r) { return r.text(); })
      .then(function (raw) {
        var d = null;
        try { d = JSON.parse(raw); } catch (e) { /* όχι JSON */ }
        if (d && d.ok) toast('✔ Η σύνδεση λειτουργεί! Ελέγξτε το έγγραφο.', 'ok', 8000);
        else toast('⚠ Απάντηση: ' + (raw || '(κενό)').slice(0, 160), 'warn', 12000);
      })
      .catch(function (err) {
        toast('❌ ' + (err.message || err), 'err', 10000);
      });
  }

  /* ==================== ΒΟΗΘΗΤΙΚΑ ==================== */

  function copyText() {
    var text = els.transcript.value;
    if (!text.trim()) { toast('Δεν υπάρχει κείμενο για αντιγραφή.', 'warn'); return; }

    function fallback() {
      els.transcript.focus();
      els.transcript.select();
      try {
        document.execCommand('copy');
        toast('📋 Αντιγράφηκε — επικολλήστε στο έγγραφο με Ctrl+V.', 'ok');
      } catch (e) {
        toast('Αποτυχία αντιγραφής.', 'err');
      }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        toast('📋 Αντιγράφηκε — επικολλήστε στο έγγραφο με Ctrl+V.', 'ok');
      }, fallback);
    } else {
      fallback();
    }
  }

  function clearAll() {
    els.transcript.value = '';
    clearTimeout(state.sendTimer);
    updateCounter();
  }

  function updateCounter() {
    var v = els.transcript.value.trim();
    var words = v ? v.split(/\s+/).length : 0;
    els.counter.textContent =
      words + (words === 1 ? ' λέξη · ' : ' λέξεις · ') +
      v.length + (v.length === 1 ? ' χαρακτήρας' : ' χαρακτήρες');
  }

  function refreshDoc() {
    var f = els.docFrame;
    var src = f.src;
    f.src = 'about:blank';
    setTimeout(function () { f.src = src; }, 120);
  }

  function saveUrl() {
    var url = (els.webappUrl.value || '').trim();
    if (url && !/^https:\/\/script\.google(usercontent)?\.com\//.test(url)) {
      toast('Το URL συνήθως έχει τη μορφή https://script.google.com/macros/s/…/exec', 'warn', 8000);
    }
    store.set('vd_webapp_url', url);
    toast('💾 Το URL αποθηκεύτηκε.', 'ok');
  }

  function persistSwitches() {
    store.set('vd_autosend', els.autoSend.checked ? '1' : '0');
    store.set('vd_commands', els.useCommands.checked ? '1' : '0');
    store.set('vd_clear',    els.clearAfterSend.checked ? '1' : '0');
  }

  function setStatus(cls, label) {
    els.statusBadge.className = 'badge' + (cls ? ' ' + cls : '');
    els.statusBadge.textContent = label;
  }

  function toast(msgText, type, ms) {
    var d = document.createElement('div');
    d.className = 'toast ' + (type || 'info');
    d.textContent = msgText;   // textContent → ασφαλές (όχι HTML injection)
    els.toasts.appendChild(d);
    setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, ms || 5000);
  }

  /* ==================== ΕΚΚΙΝΗΣΗ ==================== */
  init();
})();
