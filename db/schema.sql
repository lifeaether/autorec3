-- autorec データベーススキーマ
-- 2つのDBに分離: epg.sqlite (番組表アーカイブ) と autorec.sqlite (録画管理)

----------------------------------------------
-- epg.sqlite - 番組表アーカイブDB
----------------------------------------------
-- 使用方法: sqlite3 db/epg.sqlite < このファイルの EPG セクション
-- または setup.sh で自動作成

-- [EPG_START]
-- 番組情報 (全履歴を蓄積、削除しない)
CREATE TABLE IF NOT EXISTS programme (
    event_id    INTEGER,
    channel     TEXT NOT NULL,
    title       TEXT NOT NULL,
    description TEXT,
    start_time  TEXT NOT NULL,  -- ISO 8601
    end_time    TEXT NOT NULL,
    category    TEXT,           -- ジャンル (JSON配列)
    extra       TEXT,           -- 詳細情報 (JSON)
    updated_at  TEXT DEFAULT (datetime('now','localtime')),
    PRIMARY KEY (event_id, channel)
);

CREATE INDEX IF NOT EXISTS idx_programme_start ON programme(start_time);
CREATE INDEX IF NOT EXISTS idx_programme_channel ON programme(channel);
CREATE INDEX IF NOT EXISTS idx_programme_title ON programme(title);
CREATE INDEX IF NOT EXISTS idx_programme_category ON programme(category);
-- [EPG_END]

----------------------------------------------
-- autorec.sqlite - 録画管理DB
----------------------------------------------
-- [AUTOREC_START]
-- 録画ルール
CREATE TABLE IF NOT EXISTS rule (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,           -- ルール名 (表示用)
    keyword     TEXT,                    -- タイトル部分一致 (LIKE)
    channel     TEXT,                    -- チャンネル指定 (NULL=全ch)
    category    TEXT,                    -- ジャンル指定
    time_from   TEXT,                    -- 開始時刻 ("HH:MM", NULL=制限なし)
    time_to     TEXT,                    -- 終了時刻
    weekdays    TEXT,                    -- 曜日 ("0,1,2,3,4,5,6" 日=0, NULL=毎日)
    enabled     INTEGER DEFAULT 1,
    priority    INTEGER DEFAULT 0,       -- 重複時の優先度
    created_at  TEXT DEFAULT (datetime('now','localtime'))
);

-- 録画予定 (ルール×番組のマッチ結果)
CREATE TABLE IF NOT EXISTS schedule (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id     INTEGER REFERENCES rule(id),
    event_id    INTEGER,
    channel     TEXT NOT NULL,
    title       TEXT NOT NULL,
    start_time  TEXT NOT NULL,
    end_time    TEXT NOT NULL,
    status      TEXT DEFAULT 'scheduled'  -- scheduled / recording / done / failed / skipped
);

CREATE INDEX IF NOT EXISTS idx_schedule_start ON schedule(start_time);
CREATE INDEX IF NOT EXISTS idx_schedule_status ON schedule(status);

-- 録画ログ
CREATE TABLE IF NOT EXISTS log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    schedule_id INTEGER REFERENCES schedule(id),
    timestamp   TEXT DEFAULT (datetime('now','localtime')),
    level       TEXT NOT NULL,            -- info / warn / error
    message     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_log_schedule ON log(schedule_id);
CREATE INDEX IF NOT EXISTS idx_log_timestamp ON log(timestamp);
-- [AUTOREC_END]
