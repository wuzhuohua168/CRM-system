require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = process.env.DB_PATH || path.join(dataDir, 'crm.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');

const initSql = `
CREATE TABLE IF NOT EXISTS crm_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    data_type TEXT NOT NULL DEFAULT 'crm_records',
    data_json TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, data_type)
);

CREATE INDEX IF NOT EXISTS idx_user_id ON crm_data(user_id);
CREATE INDEX IF NOT EXISTS idx_data_type ON crm_data(data_type);
CREATE INDEX IF NOT EXISTS idx_updated_at ON crm_data(updated_at);

CREATE TABLE IF NOT EXISTS sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    action TEXT NOT NULL,
    record_count INTEGER DEFAULT 0,
    ip_address TEXT,
    user_agent TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sync_log_user ON sync_log(user_id);
CREATE INDEX IF NOT EXISTS idx_sync_log_created ON sync_log(created_at);
`;

db.exec(initSql);

app.use(helmet());
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const limiter = rateLimit({
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
    max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
    message: { error: '请求过于频繁，请稍后再试' }
});
app.use('/api/', limiter);

const authenticateAPI = (req, res, next) => {
    const apiKey = req.headers['x-api-key'] || req.query.apiKey;
    
    if (!apiKey || apiKey !== process.env.API_KEY) {
        return res.status(401).json({ 
            error: '无效的API密钥',
            code: 'INVALID_API_KEY'
        });
    }
    
    req.userId = req.headers['x-user-id'] || 'default_user';
    next();
};

app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        version: '1.0.0'
    });
});

app.post('/api/sync', authenticateAPI, (req, res) => {
    try {
        const { data, dataType = 'crm_records' } = req.body;
        
        if (!data) {
            return res.status(400).json({ 
                error: '缺少数据',
                code: 'MISSING_DATA'
            });
        }

        const dataJson = JSON.stringify(data);
        const now = new Date().toISOString();
        
        const stmt = db.prepare(`
            INSERT INTO crm_data (user_id, data_type, data_json, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id, data_type) 
            DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at
        `);
        
        stmt.run(req.userId, dataType, dataJson, now);

        const logStmt = db.prepare(`
            INSERT INTO sync_log (user_id, action, record_count, ip_address, user_agent)
            VALUES (?, ?, ?, ?, ?)
        `);
        
        const recordCount = Array.isArray(data) ? data.length : 1;
        logStmt.run(req.userId, 'upload', recordCount, req.ip, req.get('user-agent'));

        res.json({ 
            success: true, 
            message: '数据同步成功',
            recordCount,
            timestamp: now
        });
        
    } catch (error) {
        console.error('同步错误:', error);
        res.status(500).json({ 
            error: '数据同步失败',
            code: 'SYNC_ERROR',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

app.get('/api/restore', authenticateAPI, (req, res) => {
    try {
        const dataType = req.query.dataType || 'crm_records';
        
        const stmt = db.prepare(`
            SELECT data_json, updated_at 
            FROM crm_data 
            WHERE user_id = ? AND data_type = ?
        `);
        
        const row = stmt.get(req.userId, dataType);
        
        if (!row) {
            return res.status(404).json({ 
                error: '未找到数据',
                code: 'NOT_FOUND'
            });
        }

        const logStmt = db.prepare(`
            INSERT INTO sync_log (user_id, action, ip_address, user_agent)
            VALUES (?, ?, ?, ?)
        `);
        logStmt.run(req.userId, 'download', req.ip, req.get('user-agent'));

        res.json({
            success: true,
            data: JSON.parse(row.data_json),
            lastUpdated: row.updated_at,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('恢复错误:', error);
        res.status(500).json({ 
            error: '数据恢复失败',
            code: 'RESTORE_ERROR',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

app.get('/api/status', authenticateAPI, (req, res) => {
    try {
        const stmt = db.prepare(`
            SELECT data_type, updated_at, 
                   LENGTH(data_json) as size_bytes
            FROM crm_data 
            WHERE user_id = ?
        `);
        
        const rows = stmt.all(req.userId);
        
        res.json({
            success: true,
            dataTypes: rows.map(row => ({
                dataType: row.data_type,
                lastUpdated: row.updated_at,
                sizeBytes: row.size_bytes
            })),
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('状态查询错误:', error);
        res.status(500).json({ 
            error: '状态查询失败',
            code: 'STATUS_ERROR'
        });
    }
});

app.delete('/api/data', authenticateAPI, (req, res) => {
    try {
        const dataType = req.query.dataType || 'crm_records';
        
        const stmt = db.prepare(`
            DELETE FROM crm_data 
            WHERE user_id = ? AND data_type = ?
        `);
        
        const result = stmt.run(req.userId, dataType);
        
        res.json({
            success: true,
            message: '数据删除成功',
            deletedCount: result.changes
        });
        
    } catch (error) {
        console.error('删除错误:', error);
        res.status(500).json({ 
            error: '数据删除失败',
            code: 'DELETE_ERROR'
        });
    }
});

app.use((err, req, res, next) => {
    console.error('服务器错误:', err);
    res.status(500).json({ 
        error: '服务器内部错误',
        code: 'INTERNAL_ERROR'
    });
});

process.on('SIGINT', () => {
    console.log('\n正在关闭数据库连接...');
    db.close();
    process.exit(0);
});

app.listen(PORT, () => {
    console.log(`🚀 CRM API服务器运行在端口 ${PORT}`);
    console.log(`📊 数据库路径: ${dbPath}`);
    console.log(`🔒 API密钥已配置: ${process.env.API_KEY ? '是' : '否'}`);
});

module.exports = app;
