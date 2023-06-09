const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const glob = require('glob');
const moment = require('moment');
const chalk = require('chalk');
const axios = require('axios');
const core = require('@actions/core');
const asyncPool = require('tiny-async-pool');
const COS = require('cos-nodejs-sdk-v5');
const CloudBase = require('@cloudbase/manager-node')

let secretId = core.getInput('secretId');
let secretKey = core.getInput('secretKey');
let envId = core.getInput('envId');
let staticSrcPath = core.getInput('staticSrcPath');
let staticDestPath = core.getInput('staticDestPath');
let bucket = core.getInput('bucket');
let region = core.getInput('region');
let isForce = core.getInput('isForce') || false;
let skipFiles = core.getInput('skipFiles') || [];
let forceFiles = core.getInput('forceFiles') || [];
let assetFileName = core.getInput('assetFileName') || 'docschina-assets.json';
let workspace = process.env.GITHUB_WORKSPACE;

if (!process.env.CI) {
  const config = require('./config/index');
  secretId = config.secretId;
  secretKey = config.secretKey;
  envId = config.envId;
  staticSrcPath = config.staticSrcPath;
  staticDestPath = config.staticDestPath;
  bucket = config.bucket;
  region = config.region;
  isForce = config.isForce;
  skipFiles = config.skipFiles;
  forceFiles = config.forceFiles;
  workspace = __dirname;
}

const assetJsonFile = path.join(workspace, assetFileName);

const cos = new COS({
  SecretId: secretId,
  SecretKey: secretKey,
});

const md5 = (str) => {
  let md5sum = crypto.createHash('md5');
  md5sum.update(str);
  let content = md5sum.digest('hex');
  return content;
};

const getObject = async () => {
  return new Promise((resolve, reject) => {
    cos.getObject(
      {
        Bucket: bucket /* 必须 */,
        Region: region /* 必须 */,
        Key: assetFileName /* 必须 */,
        Output: fs.createWriteStream(assetJsonFile),
      },
      function (err, data) {
        // console.log(err || data);
        if (err) {
          console.log(err);
          fs.unlinkSync(assetJsonFile);
          resolve(err);
        } else {
          console.log(data);
          resolve(data);
        }
      }
    );
  });
};

/**
 * 将 html 文件放到最末尾上传
 * @param {Array} files
 */
const appendHtmlFiles = function (files) {
  let htmlFiles = [];
  let cdnFiles = [];
  files.forEach((item) => {
    if (path.extname(item) === '.html') {
      htmlFiles.push(item);
    } else {
      cdnFiles.push(item);
    }
  });

  cdnFiles = cdnFiles.concat(htmlFiles);

  return cdnFiles;
};

/**
 * 输出日志
 * @param {*} result
 * @param {*} action
 */
const logTimeResult = function (result, action = null) {
  let msg = `[${moment().format('YYYY-MM-DD HH:mm:ss')}] ${result}`;
  let color = null;

  let map = {
    error: 'red',
    info: 'cyan',
    success: 'green',
    warn: 'yellow',
  };

  if (action) {
    color = map[action] || null;
  }

  if (!color) {
    core.debug(msg);
  } else {
    core.debug(chalk[color](msg));
  }
};

const sliceUploadFileLimit = (param) => {
  return sliceUploadFile(param.uploadOption);
};

/**
 * 上传文件
 * @param {*} cos
 * @param {*} options
 */
const sliceUploadFile = function (options) {
  return new Promise((resolve, reject) => {
    cos.sliceUploadFile(options, (err, info) => {
      if (err) {
        resolve({
          code: 1,
          data: err,
        });
      } else {
        resolve({
          code: 0,
          data: info,
        });
      }
    });
  });
};

const filterFilesByCondition = ({
  scanFiles,
  skipFiles,
  forceFiles,
  codePath,
  assetJsonMap,
}) => {
  let filterFiles = scanFiles.filter((file) => {
    if (Array.isArray(skipFiles)) {
      // 手动设置跳过的文件
      for (let i = 0, len = skipFiles.length; i < len; i++) {
        if (skipFiles[i] !== '' && file.indexOf(skipFiles[i]) === 0) {
          return false;
        }
      }
    }

    if (Array.isArray(forceFiles)) {
      // 手动设置强制上传的文件
      for (let i = 0, len = forceFiles.length; i < len; i++) {
        if (forceFiles[i] !== '' && file.indexOf(forceFiles[i]) === 0) {
          return true;
        }
      }
    }

    let filePath = path.join(codePath, file);

    // 剔走目录
    let stat = fs.statSync(filePath);

    if (stat.isDirectory()) {
      return false;
    }

    // 剔走已经上传的内容
    let compareText =
      path.extname(file) !== '.html'
        ? 1
        : md5(fs.readFileSync(path.join(codePath, file)));

    if (
      assetJsonMap.mapv2.hasOwnProperty(file) &&
      assetJsonMap.mapv2[file] === compareText
    ) {
      return false;
    }


    return true;
  });
  // 将 html 文件放到最后再上传
  return appendHtmlFiles(filterFiles);
};

const initCos = async () => {
  try {
    // let result = await getObject();
    let assetJsonMap = {
      mapv2: {},
    };

    // 获取 map 数据
    try {
      let result = await axios.get(
        `http://${bucket}.cos.${region}.myqcloud.com/${assetFileName}`
      );
      // if (result.statusCode === 200 && !isForce) {
      //   assetJsonMap.mapv2 = fs.readJSONSync(assetJsonFile).mapv2 || {};
      // }
      assetJsonMap.mapv2 = result.data.mapv2 || {};
    } catch (e) {
      core.error(e.stack);
      assetJsonMap.mapv2 = {};
    }

    if (typeof skipFiles === 'string') {
      skipFiles = JSON.parse(skipFiles);
    }
    core.debug(`skipFiles: ${skipFiles}`);

    if (typeof forceFiles === 'string') {
      forceFiles = JSON.parse(forceFiles);
    }
    core.debug(`forceFiles: ${forceFiles}`);

    let codePath = path.join(workspace, staticSrcPath);
    core.debug(`codePath: ${codePath}`);

    //收集需要上传的文件，传入数组
    let scanFiles = glob.sync('**/**', { cwd: codePath });

    core.debug(`scanFiles for ${codePath}: ${scanFiles}`);

    // 剔除文件
    let files = filterFilesByCondition({
      scanFiles,
      skipFiles,
      forceFiles,
      codePath,
      assetJsonMap,
    });
    console.log('======files====:', files);

    let uploadActions = [];
    files.forEach((file) => {
      let filePath = path.join(codePath, file);
      let key = staticDestPath ? path.join(staticDestPath, file) : file;

      let uploadOption = {
        Bucket: bucket,
        Region: region,
        Key: key,
        FilePath: filePath,
      };

      uploadActions.push({ uploadOption });
    });

    core.debug(`====start uploading===`);
    // 开始上传文件
    let incrementalFiles = [];

    try {
      // let info = await Promise.all(uploadActions);
      let info = await asyncPool(10, uploadActions, sliceUploadFileLimit);

      info.forEach((result) => {
        if (!result.code && result.data && result.data.Location) {
          let item = result.data;
          logTimeResult(`${item.Location}-${item.statusCode}`);
          let splitResult = item.Location.split('/');
          let file = splitResult.splice(1, splitResult.length - 1).join('/');

          if (path.extname(file) !== '.html') {
            assetJsonMap.mapv2[file] = 1;
          } else {
            let md5Str = md5(fs.readFileSync(path.join(codePath, file)));
            assetJsonMap.mapv2[file] = md5Str;
          }

          incrementalFiles.push(file);
        } else {
          result && result.data && console.log(result.data);
        }
      });

      core.setOutput(
        'deployResult',
        'success: ' + JSON.stringify(incrementalFiles)
      );

      core.debug(`====finish uploading===`);
    } catch (e) {
      logTimeResult(`${e.Key}-${e.statusCode}-${e.Code}`, 'error');
      core.error(e.stack);
      core.setFailed(e.message);
    }

    fs.writeFileSync(assetJsonFile, JSON.stringify(assetJsonMap, 4, null));

    await sliceUploadFile({
      Bucket: bucket,
      Region: region,
      Key: assetFileName,
      FilePath: assetJsonFile,
    });

    // if (fs.existsSync(assetJsonFile)) {
    //   fs.unlinkSync(assetJsonFile);
    // }
  } catch (e) {
    core.error(e.stack);
    core.setFailed(e.message);
  }
};

/**
 *
 * initCloudBase
 *
 */

const deployHostingFile = (param) => {
  return param.cloudbase.hosting.uploadFiles({
    localPath: param.filePath, // srcpath
    cloudPath: param.key // cloudPath
  });
};

async function downloadStorageFile(cloudbase, localPath, cloudPath) {
  return cloudbase.storage.downloadFile({
    cloudPath,
    localPath,
  });
}

async function uploadStorageFile(cloudbase, localPath, cloudPath) {
  return cloudbase.storage.uploadFile({
    localPath,
    cloudPath,
  });
}

const initCloudBase = async () => {
  const cloudbase = CloudBase.init({
    secretId,
    secretKey,
    envId // 云环境 ID，可在腾讯云-云开发控制台获取
  })

  let assetJsonMap = {
    mapv2: {},
  };

  try {
    let result = await downloadStorageFile(cloudbase, assetJsonFile, assetFileName);
  } catch (e) {
    core.error(e.message);
  }

  // 获取 map 数据
  try {
    if (fs.existsSync(assetJsonFile) && !isForce) {
      assetJsonMap.mapv2 = require(assetJsonFile).mapv2 || {};
    }
  } catch (e) {
    core.error(e.stack);
    assetJsonMap.mapv2 = {};
  }

  if (typeof skipFiles === 'string') {
    skipFiles = JSON.parse(skipFiles);
  }
  core.debug(`skipFiles: ${skipFiles}`);

  if (typeof forceFiles === 'string') {
    forceFiles = JSON.parse(forceFiles);
  }
  core.debug(`forceFiles: ${forceFiles}`);

  let codePath = path.join(workspace, staticSrcPath);
  core.debug(`codePath: ${codePath}`);

  //收集需要上传的文件，传入数组
  let scanFiles = glob.sync('**/**', { cwd: codePath });

  core.debug(`scanFiles for ${codePath}: ${scanFiles}`);

  // 剔除文件
  let files = filterFilesByCondition({
    scanFiles,
    skipFiles,
    forceFiles,
    codePath,
    assetJsonMap,
  });

  let uploadFiles = [];
  files.forEach((file) => {
    let filePath = path.join(codePath, file);
    let key = staticDestPath ? path.join(staticDestPath, file) : file;

    uploadFiles.push({ cloudbase, filePath, key });
  });

  // 开始上传文件
  let incrementalFiles = [];

  try {
    let result = await asyncPool(5, uploadFiles, deployHostingFile);
    files.forEach((file) => {
      if (path.extname(file) !== '.html') {
        assetJsonMap.mapv2[file] = 1;
      } else {
        let md5Str = md5(fs.readFileSync(path.join(codePath, file)));
        assetJsonMap.mapv2[file] = md5Str;
      }
      incrementalFiles.push(file);
    });

    core.setOutput('deployResult', JSON.stringify(incrementalFiles));
  } catch (e) {
    core.error(e.message);
    logTimeResult(`${e.Key}-${e.statusCode}-${e.Code}`, 'error');
    core.setFailed(e.message);
  }

  fs.writeFileSync(assetJsonFile, JSON.stringify(assetJsonMap, 4, null));

  await uploadStorageFile(cloudbase, assetJsonFile, assetFileName);

  if (fs.existsSync(assetJsonFile)) {
    fs.unlinkSync(assetJsonFile);
  }
};

// 上传到云开发服务
if (envId) {
  initCloudBase().then(() => {});
}
// 上传到腾讯云服务
else {
  initCos().then(() => {});
}
