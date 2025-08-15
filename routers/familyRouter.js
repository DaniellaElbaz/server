const express = require('express');
const router = express.Router();
router.use((req,res,next)=>{
  console.log('HIT', req.method, req.originalUrl);
  next();
});

const familyController = require('../controllers/familyController');

router.post('/register', familyController.registerFamily);
router.post('/registerParentsChildren', familyController.registerParentsChildren);
router.post('/login', familyController.login);
router.post('/registerMembers', familyController.registerMembers);
router.get('/children', familyController.listChildren);
router.get('/parents',  familyController.listParents);
(function printRouterRoutes(prefix, router){
  try{
    router.stack
      .filter(l => l.route)
      .forEach(l => {
        const methods = Object.keys(l.route.methods).join(',').toUpperCase();
        console.log(`[ROUTE] ${methods} ${prefix}${l.route.path}`);
      });
  }catch(e){ console.warn('Route print failed:', e.message); }
})('/family', router);
router.get('/_debug', (req, res) => {
  res.json({ ok: true, scope: 'familyRouter', time: new Date().toISOString() });
});

module.exports = router;
