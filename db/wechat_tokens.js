var SQL = {  
  create:'INSERT INTO wechat_tokens(name,token) VALUES(?,?)', 
  update:'UPDATE wechat_tokens SET token=? WHERE name=?', 
  upsert:'INSERT INTO wechat_tokens(name,token) VALUES (?,?) ON DUPLICATE KEY UPDATE token=?', 
  queryAll:'SELECT * FROM wechat_tokens',
  getByName:'SELECT * FROM wechat_tokens WHERE name=?',
};
module.exports = SQL;