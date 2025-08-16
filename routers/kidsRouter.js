const express = require('express');
const router = express.Router();
const kidsController = require('../controllers/kidsController'); // ← זה השם שבו נשתמש מתחת

router.get('/tasks',kidsController.listChildTasks);
router.post('/tasks/mark-done',kidsController.markChildDone);
router.get('/score/daily',     kidsController.dailyScore);

module.exports = router;

