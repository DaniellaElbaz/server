const express = require('express');
const router = express.Router();
const familyController = require('../controllers/familyController');

router.post('/register', familyController.registerFamily);

module.exports = router;
