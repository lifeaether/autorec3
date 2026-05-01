"""録画ファイル名命名ロジック (bin/recording_path.sh と同一仕様)。

衝突時の _HHMMSS サフィックスは録画開始時にしか確定しないため、
本モジュールは「衝突なし前提」の期待ファイルパスを返す。
命名仕様変更時は bin/recording_path.sh も同様に変更すること。
"""
import os
import re


_SERIES_PATTERNS = [
    (re.compile(r'【新】'), ''),
    (re.compile(r'【終】'), ''),
    (re.compile(r'「[^」]*」'), ''),
    (re.compile(r'『[^』]*』'), ''),
    (re.compile(r'（[０-９]+）'), ''),
    (re.compile(r'（[0-9]+）'), ''),
    (re.compile(r'\([0-9]+\)'), ''),
    (re.compile(r'[　 ]*[★☆][^ 　]*'), ''),
    (re.compile(r'[　 ]*[＃#][０-９0-9]+'), ''),
    (re.compile(r'[　 ]*第[０-９0-9一二三四五六七八九十百]+[回話]'), ''),
    (re.compile(r'[　 ]+（'), '（'),
    (re.compile(r'[　 ]+【'), '【'),
    (re.compile(r'[　 ]{2,}'), '　'),
    (re.compile(r'[　 ]+$'), ''),
    (re.compile(r'^[　 ]+'), ''),
]

_INVALID_FILENAME_CHARS = re.compile(r'[\\/:*?"<>|]')


def _extract_series_name(title):
    s = title
    for pat, repl in _SERIES_PATTERNS:
        s = pat.sub(repl, s)
    return s


def _sanitize_filename(s):
    return _INVALID_FILENAME_CHARS.sub('_', s)


def expected_output_path(rule_name, channel, title, start_time, record_dir):
    """録画予定の期待出力ファイルパス。

    rule_name: ルール名 (None / 空 / 'unknown' なら title から系列名を推定)
    start_time: 'YYYY-MM-DD HH:MM:SS' 形式
    """
    if rule_name and rule_name != 'unknown':
        series = rule_name
    else:
        series = _extract_series_name(title) or title

    safe_series = _sanitize_filename(series)
    safe_channel = _sanitize_filename(channel)
    safe_title = _sanitize_filename(title)
    date_str = start_time[:10]

    return os.path.join(
        record_dir, safe_series,
        f"{date_str}_{safe_channel}_{safe_title}.ts",
    )
