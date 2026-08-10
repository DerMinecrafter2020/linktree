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
  res.json({
    ok: true,
    hasSession: !!req.session,
    sessionId: req.sessionID,
    sessionData: req.session ? { ...req.session } : null,
  });
});

module.exports = router;
