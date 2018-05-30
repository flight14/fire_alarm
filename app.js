
const express = require('express')
const http = require('http')
const os = require('os')
const path = require('path');
const bodyParser = require('body-parser');
// const mysql = require('mysql');
const mysql = require('promise-mysql');
const SMSClient = require('@alicloud/sms-sdk');
const schedule = require('node-schedule');
const {promisify} = require('util');

// setup Mysql
var config = require('./db/config');
var fireUsers = require('./db/fire_users');
var captchaSql = require('./db/captcha_sql');
var db = mysql.createPool(config.mysql);

const app = express();

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');
app.use(express.static(__dirname + '/public'));

app.use(bodyParser.urlencoded({    
  extended: false
}));
app.use(bodyParser.json());

http.createServer(app).listen(3119, function () {
  console.log('Listening on port 3119')
});

/**
 * 全局变量
 */
//oW6aH0fY6upkzy6H9OA70WC3pclI (lmm)
const WX_MSG_URL = 'http://weixin.qq.com';
const MAX_SMS_COUNT = 10;
var users = require('./users');
var alarm_tasks = [];

// ALI smsClient
const ali = require('./aliconfig');
const accessKeyId = ali.AccessKeyID;
const secretAccessKey = ali.AccessKeySecret;
const smsClient = new SMSClient({accessKeyId, secretAccessKey});

/**
 * 定时清理
 */
var j = schedule.scheduleJob('5 2 * * *', function(){
  console.log('Schedule run at', new Date().toLocaleString(), '-----------');
  db.query(captchaSql.delExpire, [], function (err, results) {
    console.log('DelExpire', err, results);
  });
});

/**
 * 从队列发送
 */
setInterval(function() {
  let t = alarm_tasks.pop();
  if( t) {
    sendAlarm(t.alarm, t.users);
  }
}, 1000);

/**
 * 微信 API 初始化
 */
let wx = require('./wxconfig');
let appId = wx.appId; 
let appSecret = wx.appSecret;
var WechatAPI = require('wechat-api')
var fs = require('fs')
var wechatApi = new WechatAPI(appId, appSecret, function (callback) {
  fs.readFile('access_token.txt', 'utf8', function (err, txt) {
    if (err) {return callback(null, null)} 
    callback(null, JSON.parse(txt))
  })
}, function (token, callback) {
  fs.writeFile('access_token.txt', JSON.stringify(token), callback)
});

var OAuth = require('wechat-oauth') 
var oauthApi = new OAuth(wx.appId, wx.appSecret, function (openid, callback) {
	  fs.readFile(__dirname+ '/token/'+ openid +'.token.txt', 'utf8', function (err, txt) {
			if (err) {return callback(err)}
			callback(null, JSON.parse(txt))
	  })
}, function (openid, token, callback) {
	  fs.writeFile(__dirname+ '/token/'+ openid + '.token.txt', JSON.stringify(token), callback)
})

/**
 * 发送报警 
 */
function sendAlarm(alarm, users) {
  let curtime = new Date().toLocaleTimeString();
  let rectime = alarm.rtime.toLocaleString();
  console.error('SendAlarm r', rectime, 's', curtime, alarm.type, '----------------');
  
  users.forEach( function(user) {
    if(!user.openid)  return;
    
    wechatApi.sendTemplate(user.openid, alarm.templateId, 
      alarm.url, alarm.data, function(err, result) {
      console.log('Send', user.mobile, result);
    })
  });
}

/**
 * 验证手机号码格式
 */
function validMobile(number) {
  if(!number) return false;
  return (/(^(13\d|15[^4,\D]|17[13678]|18\d)\d{8}|170[^346,\D]\d{7})$/.test(number));
}

/**
 * 计算随机验证码
 */
function random(len) {
  len = len || 4;
  var num = "";
  for (i = 0; i < len; i++) {
    num = num + Math.floor(Math.random() * 10);
  }
  return num;
}

/**
 * 处理批量手机号码
 */
function dryMobiles(mobile) {
  let mobiles = mobile.split(',');
  let dry_mobs = mobiles.map( (m) => {
    return m.trim();
  });
  return dry_mobs;
}

// -- routers ------------------------------------------------------
app.get('/', function (req, res, next) {
  setTimeout(() => res.end('Hello Fire Alarm!'), Math.random() * 500);
});

/**
 * 微信网页入口
 */
app.get('/fire/start', function (req, res, next) {
  var callbackURL = wx.webUrl + '/fire/bind';
  var url = oauthApi.getAuthorizeURL(callbackURL,'state','snsapi_base');
  res.redirect(url);
});

/**
 * 绑定表单
 */
app.get('/fire/bind', function (req, res, next) {
  let code = req.query.code;
  if(!code)  return res.sendStatus(401);
  let openid = null;
	
  const getAccessTokenPro = promisify(oauthApi.getAccessToken).bind(oauthApi);
  getAccessTokenPro(code).then( result => {
    // console.log('getAccessToken', result);
    openid = result.data.openid;
    if(!openid)  return res.status(401).send('微信id获取错误！');
    
    // 查询用户绑定
    return db.query(fireUsers.getUserByOpenid, [openid]);
  }).then( users => {
    // console.log('users:', users);
    let bound = (users.length > 0);
    let mobile = bound? users[0].mobile: '';
    
    res.render('bind', {bound, mobile, openid});
  }).catch(err => {
    console.error('/fire/bind err:', err);
    return next(err);
  });  
});

/**
 * 绑定表单(提交)
 */
app.post('/fire/bind', function (req, res, next) {
  let tobind = (req.body.tobind == 'true');
  let mobile = (req.body.mobile || '').trim();
  let captcha = (req.body.captcha || '').trim();
  let openid = (req.body.openid || '').trim();
  //console.log('tobind & mobile & captcha:', tobind, mobile, captcha);
  
  // VALID mobile + openid
  if(!validMobile(mobile)) {
    let error = '手机号格式错误';
    return res.redirect('/result?ok=0&err='+error);
  }
  else if(!openid || !captcha) {
    let error = '微信id丢失或没有验证码';
    return res.redirect('/result?ok=0&err='+error);
  }
  
  // VALID captcha
  db.query(captchaSql.getByMobile, [mobile], function (err, results) {
    // console.log('results', err, results);
    if(err) return next(err);    
    if(!results.length || results[0].captcha != captcha) {
      let error = '验证码无效';
      return res.redirect('/result?ok=0&err='+error);
    }
    
    let is_expire = (new Date(results[0].expire*1000)) < (new Date());
    if( is_expire) {
      let error = '验证码过期';
      return res.redirect('/result?ok=0&err='+error);
    }
    
    // Bind or Unbind
    if(tobind) {
      db.query(fireUsers.getUserByMobile, [mobile], function (err, results) {
        //console.log('results', err, results);
        if(err) return next(err);
        if(results.length > 0) {
          let error = '该手机号已被绑定过';
          res.redirect('/result?ok=0&err='+error);
        }
        else {
          db.query(fireUsers.create, [mobile, openid], function (err, okPacket) {
            //console.log('okPacket', err, okPacket);
            if(err) return next(err);
            if( okPacket.affectedRows == 1) {
              console.log('Bind mobile: '+ mobile);
              res.redirect('/result?ok=1');
            }
            else {
              let error = '数据库插入错误';
              res.redirect('/result?ok=0&err='+error);
            }
          });
        }
      });
    }
    else {
      db.query(fireUsers.delUserByMobile, [mobile], function (err, okPacket) {
        //console.log('okPacket', err, okPacket);
        if(err) return next(err);
        if( okPacket.affectedRows == 1) {
          console.log('Unbind mobile: '+ mobile);
          res.redirect('/result?ok=1');
        }
        else {
          let error = '数据库删除错误';
          res.redirect('/result?ok=0&err='+error);
        }
      });
    }
    
  });
  
  return;
});

/**
 * 操作结果
 */
app.get('/result', function (req, res, next) {
  let ok = req.query.ok > 0? true: false;
  let err = req.query.err || '未知错误';
  res.render('result', {ok, err});
});

/**
 * 发送验证码
 */
app.post('/sendsms', function (req, res, next) {
  let mobile = (req.body.mobile || '').trim();
  if(!validMobile(mobile)) {
    return res.json({err:101, msg:'手机号码格式错误'});
  }
  let expire, captcha, count;
  
  db.query(captchaSql.getByMobile, [mobile]).then( results => {
    // 限制条数
    expire = parseInt(new Date().getTime()/1000) + 5*60;
    captcha = random(4); //'1234'
    count = (!results.length)? 0: results[0].count;
    console.log('sms', mobile, 'count', count);
    if( ++count > MAX_SMS_COUNT) {
      return res.json({err:102, msg:'短消息发送次数过多'});
    }
    
    // 短信发送
    return smsClient.sendSMS({
      PhoneNumbers: mobile,
      SignName: '倍省提醒',
      TemplateCode: 'SMS_135026027',
      TemplateParam: '{"code":"'+ captcha +'"}'
    })
  }).then( result => {
    //console.log('SMS result:', result);
    let {Code}=result;
    if (Code === 'OK') {
      res.json({err:0, msg:'ok'});
      
      // 插入更新db
      return db.query(captchaSql.upsert, [mobile,captcha,expire,captcha,expire,count]);
    }
    else {
      return 'SMS Failed! Should be caught below';
    }
  }).then( result => {
    console.log('captchaSql.upsert:', result);
  }).catch( err => {
    if( err.data) {
      // SMS error
      console.log('SMS error:', err);
      res.json({err:err.data.Code, msg:err.data.Message});
    }
    else {
      // DB error(maybe)
      console.log('DB error:', err);
      res.json({err:199, msg:'DB发生未知错误'});
    }
  });
  
});

/**
 * 消防报警对外 API 接口
 */
app.post('/fire/alarm', function (req, res, next) {
  let token = (req.body.token || '').trim();
  let mobile = (req.body.mobile || '').trim();
  let rtime = new Date();
  console.log('RecvMobile', rtime.toLocaleString(), mobile);
    
  // 验证 token 正确
  if( token != '20180516') {
    return res.sendStatus(401);
  }
  
  if( !mobile) {
    return res.sendStatus(500);
  }
  let dry_mobs = dryMobiles(mobile);
  
  // 收集整理数据
  let store = req.body.store || '默认1店';
  let device = req.body.device || '默认设备';
  let status = req.body.status || '默认参数超标！';
  let time = req.body.time || new Date().toLocaleString();
  
  let alarm = {};
  alarm.templateId = wx.tmpIdFireAlarm;;
  alarm.url = WX_MSG_URL;
  alarm.data = {
    "first":{
    "value": '你好, 请注意:',
    "color": "#173177"
    },
    "keyword1":{
    "value": time,
    "color": "#173177"
    },
    "keyword2":{
    "value": store,
    "color": "#173177"
    },
    "keyword3": {
    "value": device,
    "color": "#173177"
    },
    "keyword4": {
    "value": status,
    "color":"#173177"
    },
    "remark":{
    "value": '请及时处理！',
    "color":"#173177"
    }
  };
  alarm.type = 'fire_alarm';
  alarm.rtime = rtime;
  
  // 查询并发送报警
  db.query(fireUsers.getUsersByMobile, [dry_mobs]).then( users => {
    let task = {alarm, users};
    alarm_tasks.unshift(task);
    
    let to_mobiles = users.map(function(u) {
      return u.mobile;
    });
    
    res.send({
      err: 0,
      msg: 'success',
      to_mobiles,
    });
  }).catch( err => {
    return next(err);
  });
  
});

app.get('/test', function (req, res) {
  let store = 'TEST1店';
  let device = 'TEST压缩机';
  let status = 'TEST压力报警';
  let time = new Date().toLocaleString();
  
  let alarm = {};
  alarm.templateId = wx.tmpIdFireAlarm;
  alarm.url = WX_MSG_URL;
  alarm.data = {
    "first":{
    "value": '你好, 请注意:',
    "color": "#173177"
    },
    "keyword1":{
    "value": time,
    "color": "#173177"
    },
    "keyword2":{
    "value": store,
    "color": "#173177"
    },
    "keyword3": {
    "value": device,
    "color": "#173177"
    },
    "keyword4": {
    "value": status,
    "color":"#173177"
    },
    "remark":{
    "value": '请及时处理！',
    "color":"#173177"
    }
  };
  alarm.type = 'fire_alarm';
  alarm.rtime = new Date();
  
  sendAlarm(alarm, users);
  res.send('test');
});

/**
 * KPI 报警对外 API 接口
 */
app.post('/kpi/alarm', function (req, res, next) {
  let token = (req.body.token || '').trim();
  let mobile = (req.body.mobile || '').trim();
  let rtime = new Date();
  console.log('RecvMobile', rtime.toLocaleString(), mobile);
    
  // 验证 token 正确
  if( token != '20185523') {
    return res.sendStatus(401);
  }
  
  if( !mobile) {
    return res.sendStatus(500);
  }
  let dry_mobs = dryMobiles(mobile);
  
  // 收集整理数据
  let firstline = req.body.firstline || '默认设备 温度超标！数值:15 标准:0-10';
  let level_name = req.body.level_name || '报警';
  let level_color = req.body.level_color || '#16A765';
  let curtime = req.body.curtime || new Date().toLocaleString();
  let location = req.body.location || '默认库房';
  let contact = req.body.contact || '默认联系人';
  let workorder = req.body.workorder || 'n/a';
  let lastline = req.body.lastline || '已持续x分钟, 请及时处理！';
  
  let alarm = {};
  alarm.templateId = wx.tmpIdKpiAlarm;
  alarm.url = WX_MSG_URL;
  alarm.data = {
    "first": {
      "value": firstline, 
      "color":"#173177"
    },
    "keyword1":{
      "value": level_name,
      "color": level_color
    },
    "keyword2": {
      "value": curtime,
      "color":"#173177"
    },
    "keyword3": {
      "value": location,
      "color":"#173177"
    },
    "keyword4": {
      "value": contact,
      "color":"#173177"
    },
    "keyword5": {
      "value": workorder,
      "color":"#173177"
    },
    "remark":{
      "value": lastline,
      "color":"#173177"
    }
  };
  alarm.type = 'kpi_alarm';
  alarm.rtime = rtime;
  
  // 查询并发送报警
  db.query(fireUsers.getUsersByMobile, [dry_mobs]).then( users => {
    let task = {alarm, users};
    alarm_tasks.unshift(task);
    
    let to_mobiles = users.map(function(u) {
      return u.mobile;
    });
    
    res.send({
      err: 0,
      msg: 'success',
      to_mobiles,
    });
  }).catch( err => {
    return next(err);
  });
});

// catch 404 and forward to error handler
app.use(function(req, res, next) {
  var err = new Error('Not Found');
  err.status = 404;
  next(err);
});

// error handler
app.use(function(err, req, res, next) {
  // set locals, only providing error in development
  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};

  // render the error page
  res.status(err.status || 500);
  res.render('error');
});
