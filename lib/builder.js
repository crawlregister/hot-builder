
'use strict';

var async = require('async');
var colors = require('colors');
var EntryFile = require('./entry-file');
var EventEmitter = require('events').EventEmitter;
var extend = require('extend');
var fs = require('fs');
var glob = require('glob');
var inherits = require('inherits');
var inquirer = require('inquirer');
var moduleFinder = require('./module-finder');
var ModuleItem = require('./module-item');
var npm = require('npm');
var path = require('path');
var replacer = require('./utils/replacer');
var Worker = require('./worker');

colors.setTheme({
  log: 'white',
  info: 'green',
  help: 'cyan',
  warn: 'yellow',
  debug: 'blue',
  error: 'red'
});

module.exports = Builder;

inherits(Builder, EventEmitter);

/**
 * @param {Object} argv
 * @param {Object} options
 * @returns {Builder}
 * @constructor
 */
function Builder(argv, options) {
  var _this = this;

  if (!(this instanceof Builder)) {
    return new Builder(argv, options);
  }
  argv = argv || {};
  this.options = options || {};
  this.options.hotBranch = this.options.hotBranch || argv['hot-branch'];

  // Read your own (hot-builder) package.json
  this.builderPackage = JSON.parse(fs.readFileSync(path.resolve(path.join(__dirname, '..', 'package.json'))).toString());
  this.moduleFinder = null;
  this.entryFile = new EntryFile();

  if (this.options.hotBranch) {
    this.installHot(this.options.hotBranch, function(err) {
      if (err) {
        return _this.emit('error', err);
      }
      _this.init(argv);
    });
  } else {
    this.init(argv);
  }
}

/**
 * Initialize builder
 *
 * @param {Object} argv
 */
Builder.prototype.init = function(argv) {
  var _this = this,
    // for npm 2.* or cli
    hotDefaultPath = path.join(__dirname, '..', 'node_modules', 'hot-cg', 'package.json'),
    inputFile, inputPackage;

  try {
    fs.accessSync(hotDefaultPath);
  } catch (e) {
    // for npm 3.*
    hotDefaultPath = path.join(__dirname, '..', '..', 'hot-cg', 'package.json');
  }

  if (!this.options.input && !argv.input) {
    this.defaultInput = true;
  }
  inputFile = path.resolve(this.options.input || argv.input || hotDefaultPath);
  inputPackage = JSON.parse(fs.readFileSync(inputFile).toString());

  if (inputPackage.name === 'handsontable-pro') {
    this.entryFile.addFile(EntryFile.TYPE_PRO, inputFile);
    inputFile = hotDefaultPath;
  }
  this.entryFile.addFile(EntryFile.TYPE_BASE, inputFile);

  // setup default option values
  this.options.cli = argv.cli;
  this.options.outputDir = this.options.outputDir || argv['output-dir'];
  this.options.minify = this.options.minify !== undefined ? this.options.minify : (argv['minify'] || false);
  this.options.disableUI = this.options.disableUI || argv['disable-ui'];
  this.options.devMode = this.options.devMode || argv['dev-mode'];
  this.options.external = this.options.external || this.parseArgumentAsArray(argv, 'modules-src', ['plugins', 'validators', 'renderers', 'editors']);
  this.options.include = this.options.include || this.parseArgumentAsAddRemoveModule(argv, 'add-module');
  this.options.exclude = this.options.exclude || this.parseArgumentAsAddRemoveModule(argv, 'remove-module');
  this.options.npmModulesDescriptor = {};

  this.entryFile.setDestination(this.options.outputDir);

  if (!this.options.includeTypes) {
    this.options.includeTypes = [];

    if (argv.all) {
      this.options.includeTypes.push('all');
    } else {
      // TODO: Support for validators, renderers and editors is not ready yet
      //ModuleItem.TYPES.forEach(function(type) {
      //  if (argv['all-' + type + 's']) {
      //    _this.options.includeTypes.push(type);
      //  }
      //});
    }
  }
  // By default include all modules by that types
  this.options.includeTypes.push('validator', 'renderer', 'editor');

  EntryFile.TYPES.forEach(function(type) {
    var file = this.entryFile.getFile(type);

    if (file && file.package.builderDependencies) {
      extend(this.options.npmModulesDescriptor, file.package.builderDependencies);
    }
  }, this);

  var basePackage = this.entryFile.getFile(EntryFile.TYPE_BASE).package;

  if (this.entryFile.hasFile(EntryFile.TYPE_PRO)) {
    replacer.setVariables(this.entryFile.getFile(EntryFile.TYPE_PRO).package);
    replacer.setVariables({baseVersion: basePackage.version});
  } else {
    replacer.setVariables(basePackage);
  }
  this.moduleFinder = moduleFinder(this.buildExternalModulesDescriptor(this.options.external));

  if (this.options.disableUI) {
    run();
  }
  else {
    this.showUIPrompt(function(selected) {
      // reset include types (exclude `all` if there was earlier)
      _this.options.includeTypes = ['validator', 'renderer', 'editor'];
      _this.options.include = selected.modules;

      run();
    });
  }
  function run() {
    var hotVersion = 'hot-cg v' + _this.entryFile.getFile(EntryFile.TYPE_BASE).package.version;

    if (_this.options.hotBranch) {
      hotVersion = hotVersion + ', ' + _this.options.hotBranch;
    }
    console.log(('Creating custom build (' + hotVersion + ')...\n').underline.log);

    _this.runTask();
  }
};

/**
 * Install handsontable as dependency
 *
 * @param {String} version Handsontable version (default is latest version)
 * @param {Function} callback
 */
Builder.prototype.installHot = function(version, callback) {
  version = version || 'master';

  if (version === 'latest') {
    version = 'master';
  }
  // TODO: Use lighter version of git cloning tool
  npm.load(this.builderPackage, function(err) {
    if (err) {
      return err;
    }
    var orgPrefix = npm.prefix;

    if (version === 'link') {
      npm.prefix = __dirname + '/..';
      npm.commands.link('hot-cg', callback);
      npm.prefix = orgPrefix;
    }
    else {
      npm.commands.install(__dirname + '/..', ['git://github.com/crawlregister/hot-cg#' + version], callback);
    }
  });
};

/**
 * @param {Array} external
 * @returns {Array}
 */
Builder.prototype.buildExternalModulesDescriptor = function(external) {
  var
    result = [],
    fileBase, filePro,
    requireNpmModules;

  requireNpmModules = Object.keys(this.options.npmModulesDescriptor).join('|');
  fileBase = this.entryFile.getFile(EntryFile.TYPE_BASE);
  filePro = this.entryFile.getFile(EntryFile.TYPE_PRO);

  EntryFile.TYPES.forEach(function(type) {
    var file = this.entryFile.getFile(type);

    if (!file) {
      return;
    }
    external.forEach(function(dirName) {
      var _path = path.resolve(path.join(file.srcPath, dirName));

      if (!fs.existsSync(_path)) {
        return;
      }
      result.push({
        type: dirName === 'plugins' ? 'dir' : 'file',
        path: fs.realpathSync(_path),
        isPro: type === EntryFile.TYPE_PRO
      });
    });
  }, this);

  // Path to internal modules (our internal libraries)
  result.push({
    type: 'dir',
    path: fileBase.internalLibPath,
    internal: true
  });

  // Parse only npm modules defined in hot-builder package.json ("builderDependencies")
  var npmPath = filePro ? filePro.path : fileBase.path;

  if (this.options.cli && this.defaultInput) {
    npmPath = npmPath.replace(path.join('node_modules', 'hot-cg'), '');
  }
  // Support for npm 3.*
  result.push({
    type: 'dir',
    path: path.resolve(path.join(npmPath, 'node_modules') + '/@(' + requireNpmModules + ')'),
    external: true,
    npm: true,
    modulesDescriptor: this.options.npmModulesDescriptor
  });
  // Support for npm 2.*
  result.push({
    type: 'dir',
    path: path.resolve(path.join(__dirname, '..', 'node_modules', 'hot-cg', 'node_modules') + '/@(' + requireNpmModules + ')'),
    external: true,
    npm: true,
    modulesDescriptor: this.options.npmModulesDescriptor
  });

  return result;
};

/**
 * Create and show UI Prompt with all available modules to select
 *
 * @param callback
 */
Builder.prototype.showUIPrompt = function(callback) {
  var choices = [],
    labels = {
      plugin: {label: new inquirer.Separator('Plugins (free):'.yellow), modules: []},
      pluginPro: {label: new inquirer.Separator('Plugins (pro):'.yellow), modules: []},
      external: {label: new inquirer.Separator('External libraries:'.yellow), modules: []}
    };

  choices.push(new inquirer.Separator());

  this.moduleFinder.getModulesSortedByName().forEach(function(module) {
    // TODO: for now we exclude all modules others then `plugin` and `external`
    if (!module.isPlugin() && !module.isExternal()) {
      return;
    }
    var type = module.type;

    if (module.isPro()) {
      type = type + 'Pro';
    }
    labels[type].modules.push(module);
  }, this);

  Object.keys(labels).forEach(function(labelKey) {
    var label = labels[labelKey];

    if (label.modules.length) {
      choices.push(label.label);
    }
    label.modules.forEach(function(module) {
      choices.push({
        name: module.name
      });
    });
  });

  inquirer.prompt([{
      type: 'checkbox',
      message: 'Select modules that will be used to build your custom Handsontable distribution package',
      name: 'modules',
      choices: choices,
      paginated: false
    }
  ], callback);
};

/**
 * Run task
 */
Builder.prototype.runTask = function() {
  var
    _this = this,
    runner,
    now;

  now = new Date().getTime();

  runner = new Worker(this.moduleFinder, this.options);
  runner.on('complete', function(entryFile) {
    var time = new Date().getTime() - now;

    time = time + 'ms';
    _this.emit('complete');
    console.log('Created files in ' + entryFile.getDestination().green + ' directory (' + time.yellow + ').');
  });

  runner.run(this.entryFile);
};

/**
 * Parse arguments like add-(plugin|editor|renderer) and remove-(plugin|editor|renderer)
 *
 * @param {Object} argv
 * @param {String} key
 * @returns {Array}
 */
Builder.prototype.parseArgumentAsAddRemoveModule = function(argv, key) {
  var arr = this.parseArgumentAsArray(argv, key);

  if (arr.length === 1 && /,/.test(arr[0])) {
    arr = arr[0].split(',');
  }
  arr = arr.map(function(moduleName) {
    return moduleName[0].toUpperCase() + moduleName.substr(1);
  });

  return arr;
};

/**
 * Parse argument as array
 *
 * @param {Object} argv
 * @param {String} key
 * @param {*} [defaults]
 * @returns {Array}
 */
Builder.prototype.parseArgumentAsArray = function(argv, key, defaults) {
  defaults = defaults || [];

  return Array.isArray(argv[key]) ? argv[key] : (argv[key] ? [argv[key]] : defaults);
};
