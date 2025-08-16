const express = require('express');
const router = express.Router();


const familyController = require('../controllers/familyController');

router.post('/register', familyController.registerFamily);
router.post('/registerParentsChildren', familyController.registerParentsChildren);
router.post('/login', familyController.login);
router.post('/registerMembers', familyController.registerMembers);
router.get('/children', familyController.listChildren);
router.get('/parents',  familyController.listParents);
router.post('/loginMember', familyController.loginMember);

module.exports = router;
