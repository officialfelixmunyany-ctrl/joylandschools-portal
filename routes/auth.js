const express = require('express');
const bcrypt  = require('bcryptjs');
const { getDB } = require('../database');
const router  = express.Router();

function rememberRoleSession(req, sessionUser) {
  if (!req.session.roleUsers) req.session.roleUsers = {};
  req.session.roleUsers[sessionUser.role] = sessionUser;
  req.session.user = sessionUser;
}

router.post('/login', (req, res) => {
  const { identifier, password } = req.body;
  if (!identifier || !password) return res.json({ success:false, message:'Please enter your ID and password' });
  const db = getDB();
  let user = db.prepare(`SELECT * FROM users WHERE (user_id=? OR email=?) LIMIT 1`).get(identifier, identifier);
  if (!user) {
    const parent = db.prepare(`SELECT * FROM parent_accounts WHERE (parent_id=? OR email=? OR phone=?) LIMIT 1`).get(identifier, identifier, identifier);
    if (parent) user = { ...parent, user_id:parent.parent_id, role:'parent', is_admin:0 };
  }
  if (!user) return res.json({ success:false, message:'User not found. Check your ID, phone, or email.' });
  if (user.status === 'inactive') return res.json({ success:false, message:'Your account has been deactivated. Contact admin.' });
  if (!bcrypt.compareSync(password, user.password)) return res.json({ success:false, message:'Incorrect password.' });

  const role = user.role;
  rememberRoleSession(req, { id:user.id, user_id:user.user_id, name:user.name, role, original_role:user.role, is_admin:user.is_admin });
  res.json({ success:true, role, name:user.name, redirect:`/${role}` });
});

router.post('/temp-login', (req, res) => {
  const { identifier, temp_code } = req.body;
  if (!identifier || !temp_code) return res.json({ success:false, message:'Please enter your ID and temporary code' });
  const db = getDB();
  let user = db.prepare(`SELECT * FROM users WHERE (user_id=? OR email=?) AND temp_code=? LIMIT 1`).get(identifier, identifier, temp_code.trim().toUpperCase());
  if (!user) {
    const parent = db.prepare(`
      SELECT * FROM parent_accounts
      WHERE (parent_id=? OR email=? OR phone=?) AND temp_code=?
      LIMIT 1
    `).get(identifier, identifier, identifier, temp_code.trim().toUpperCase());
    if (parent) user = { ...parent, user_id:parent.parent_id, role:'parent', is_admin:0 };
  }
  if (!user) return res.json({ success:false, message:'Invalid temporary code or login ID.' });
  if (user.status === 'inactive') return res.json({ success:false, message:'Account deactivated. Contact admin.' });
  if (user.temp_code_expiry && new Date(user.temp_code_expiry) < new Date()) return res.json({ success:false, message:'This temporary code has expired. Request a new one.' });

  const role = user.role;
  rememberRoleSession(req, { id:user.id, user_id:user.user_id, name:user.name, role, original_role:user.role, is_admin:user.is_admin, must_change_password:true });
  res.json({ success:true, role, name:user.name, must_change_password:true, redirect:`/${role}` });
});

router.post('/logout', (req, res) => { req.session.destroy(); res.json({ success:true }); });

router.get('/me', (req, res) => {
  if (!req.session.user) return res.json({ authenticated:false });
  res.json({ authenticated:true, user:req.session.user });
});

module.exports = router;
