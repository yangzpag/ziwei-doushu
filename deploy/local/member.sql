-- member 模块表（官方 sql/postgresql 未包含，按 MemberUserDO/MemberGroupDO 手写，风格对齐官方 dump）

-- ----------------------------
-- Table structure for member_user
-- ----------------------------
DROP TABLE IF EXISTS member_user;
CREATE TABLE member_user (
    id int8 NOT NULL,
  mobile varchar(16) NULL,
  email varchar(50) NULL,
  password varchar(100) NOT NULL DEFAULT '',
  status int2 NOT NULL DEFAULT 0,
  register_ip varchar(32) NULL DEFAULT NULL,
  register_terminal int2 NULL DEFAULT NULL,
  login_ip varchar(50) NULL DEFAULT NULL,
  login_date timestamp NULL DEFAULT NULL,
  nickname varchar(30) NOT NULL DEFAULT '',
  avatar varchar(255) NULL DEFAULT NULL,
  name varchar(30) NULL DEFAULT NULL,
  sex int2 NULL DEFAULT NULL,
  birthday timestamp NULL DEFAULT NULL,
  area_id int4 NULL DEFAULT NULL,
  mark varchar(255) NULL DEFAULT NULL,
  point int4 NOT NULL DEFAULT 0,
  tag_ids varchar(255) NULL DEFAULT NULL,
  level_id int8 NULL DEFAULT 0,
  experience int4 NULL DEFAULT 0,
  group_id int8 NULL DEFAULT NULL,
  mobile_verified boolean NOT NULL DEFAULT false,
  creator varchar(64) NULL DEFAULT '',
  create_time timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updater varchar(64) NULL DEFAULT '',
  update_time timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted int2 NOT NULL DEFAULT 0,
  tenant_id int8 NOT NULL DEFAULT 0,
  CONSTRAINT member_user_pkey PRIMARY KEY (id)
);
CREATE SEQUENCE member_user_seq START 1;
ALTER SEQUENCE member_user_seq OWNED BY member_user.id;
CREATE UNIQUE INDEX uk_mobile ON member_user (mobile) WHERE mobile IS NOT NULL;
CREATE INDEX idx_member_user_email ON member_user (email);

-- ----------------------------
-- Table structure for member_group
-- ----------------------------
DROP TABLE IF EXISTS member_group;
CREATE TABLE member_group (
    id int8 NOT NULL,
  name varchar(30) NOT NULL DEFAULT '',
  remark varchar(255) NULL DEFAULT NULL,
  status int2 NOT NULL DEFAULT 0,
  sort int4 NOT NULL DEFAULT 0,
  creator varchar(64) NULL DEFAULT '',
  create_time timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updater varchar(64) NULL DEFAULT '',
  update_time timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted int2 NOT NULL DEFAULT 0,
  tenant_id int8 NOT NULL DEFAULT 0,
  CONSTRAINT member_group_pkey PRIMARY KEY (id)
);
CREATE SEQUENCE member_group_seq START 1;
ALTER SEQUENCE member_group_seq OWNED BY member_group.id;

-- 默认用户分组
INSERT INTO member_group (id, name, remark, status, sort, tenant_id) VALUES (1, '默认分组', '默认用户分组', 0, 0, 1);
