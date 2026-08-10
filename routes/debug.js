// Temporaere Debug-Routen fuer Session-Probleme
const express = require('express');
const router = express.Router();

router.get('/session', (req, res) => {
  res.json({
    ok: true,
    hasSession: !!req.session,
    sessionId: req.sessionID,
    sessionData: req.session ? { ...req.session } : null,
    cookies: req.headers.cookie || null,
  });
});

router.post('/session', (req, res) => {
  if (req.session) {
    req.session.testValue = Date.now();
    req.session.testEmail = req.body.email || 'debug@example.com';
  }
  const oldJson = res.json.bind(res);
  res.json = function(body) {
    console.log('[debug] sessionId:', req.sessionID, 'modified:', req.session ? req.session.isModified : 'n/a');
    return oldJson(body);
  };
  res.json({
    ok: true,
    hasSession: !!req.session,
    cookieSet: !!res.get('Set-Cookie'),
  });
});

module.exports = router;
