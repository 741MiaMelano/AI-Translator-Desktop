-- 创建项目那一屏的自动/半自动选择此前只活在内存里：project_config 是固定列集合，
-- 没有对应的列，所以 autoTranslate 写不进磁盘。用户选了「全自动」，一次重载之后
-- 流水线又按半自动停在翻译前——开关看起来没生效。
-- 默认 0（手动确认翻译），与既有项目的实际行为一致。
ALTER TABLE project_config ADD COLUMN auto_translate INTEGER NOT NULL DEFAULT 0;
