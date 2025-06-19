const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());


const familyRouter = require('./routers/familyRouter');


app.use('/family', familyRouter);

app.listen(3000, () => {
    console.log('Server is running on port 3000');
});
