const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/kidsTriviaController');

// GET /kids/trivia/today?family_key=&child_id=&date=YYYY-MM-DD
router.get('/today', ctrl.getTodayQuestion);
// POST /kids/trivia/answer  { family_key, child_id, date, question_id, choice }
router.post('/answer', ctrl.submitAnswer);
router.get('/trivia/today', ctrl.triviaToday);
module.exports = router;
