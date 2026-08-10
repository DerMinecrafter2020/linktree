// Temporaere Debug-Routen fuer Session-Probleme
const express = require('express');
const router = express.Router();

router.get('/session', (req, res) => {
  res.json({
    ok: true,
    hasSession: !!req.session,
    secure: req.secure,
    protocol: req.protocol,
    forwardedProto: req.get('x-forwarded-proto') || null,
    trustProxy: req.app.get('trust proxy'),
  });
});

router.post('/session', (req, res) => {
  if (req.session) {
    req.session.testValue = Date.now();
    req.session.testEmail = req.body.email || 'debug@example.com';
  }
  req.session.save((err) => {
    console.log('[debug] save callback err:', err ? err.message : 'none');
    res.json({ ok: true, hasSession: !!req.session, cookieSet: !!res.get('Set-Cookie'), saved: !err });
  });
});

module.exports = router;
