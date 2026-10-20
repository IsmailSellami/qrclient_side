const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const app = express();
const pg = require('pg');
const path = require('path');
const http = require('http');
const port = 5050;

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
// Serve static files from the project `file` folder (contains index.html, style.css, script.js)
app.use(express.static(path.join(__dirname, '..', 'file')));

require('dotenv').config();
const databaze = process.env.DATABASE_URL;
const client = new pg.Client(databaze)
// create HTTP server and attach socket.io
const httpServer = http.createServer(app);
async function startServer() {
    try {
        await client.connect(); 
        console.log('Connected to database');
    } catch (err) {
        console.warn('Database connection failed — starting server anyway:', err && err.message ? err.message : err);
    }

    // start HTTP server (socket.io attached)
    httpServer.listen(port, () => {
        console.log(`Server is running on port ${port}`);
    });
}

startServer();
app.get('/', getfile);
    function getfile(req, res) {
        res.sendFile(path.join(__dirname, '..', 'file','html','index.html'));
    };

// minimal login route for React dev proxy
app.get('/getdata', async (req, res) => {
    try {
        const result = await client.query('SELECT * FROM categorie');
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'DB_ERROR' });
    }
});
app.get("/product",product)
function product(req,res){
   const query = 'SELECT * FROM product';
       client.query(query).then(function(result){
        res.json(result.rows);
    })
}

app.post('/demander', async function demander(req, res) {
    const payload = req.body || {};
    const numtable = 25;
    console.log('Extracted numtable:', numtable);
    const items = Array.isArray(payload.items) ? payload.items : [];
    const totale = payload.totale;

    if (!items.length) {
        return res.status(400).json({ success: false, error: 'EMPTY_CART' });
    }
    if (totale === undefined || totale === null || Number.isNaN(Number(totale))) {
        return res.status(400).json({ success: false, error: 'INVALID_TOTAL' });
    }

    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toTimeString().slice(0, 8);

    let idrecu;

    try {
        await client.query('BEGIN');

        const verifyTable = await client.query(
            'SELECT idrecu FROM recu WHERE id=$1 AND heurf IS NULL',
            [numtable]
        );

        if (verifyTable.rowCount === 0) {
            const recuInsert = await client.query(
                'INSERT INTO recu (id, totale, date, heurd, heurf) VALUES ($1,$2,$3,$4,$5) RETURNING idrecu',
                [numtable, Number(totale), dateStr, timeStr, null]
            );
            console.log('Inserted new recu, result:', recuInsert);
            idrecu = recuInsert.rows[0].idrecu;

            await client.query(
                'UPDATE tablee SET type=$1, idrecu=$2 WHERE id=$3',
                ['occupied', idrecu, numtable]
            );
        }    else {
    idrecu = verifyTable.rows[0].idrecu;

    const updateResult = await client.query(
        'UPDATE recu SET totale=totale+$1 WHERE idrecu=$2 RETURNING idrecu, totale',
        [Number(totale), idrecu]
    );

    if (updateResult.rowCount > 0) {
        console.log('✅ Updated existing recu:', updateResult.rows[0]);
    } else {
        console.log('⚠️ No recu was updated. Something went wrong.');
    }
}
        for (const item of items) {
            await client.query(
                'INSERT INTO orderr (idrecu, id, idname, optionn,status) VALUES ($1,$2,$3,$4,$5)',
                [idrecu, numtable, String(item.idname), item.optionn ?? null, 'online']
            );
        }

        await client.query('COMMIT');
        console.log('Extracted numtable:', numtable);
        return res.json({ success: true, idrecu });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
    }
});


//12 add sortie-auto endpoin