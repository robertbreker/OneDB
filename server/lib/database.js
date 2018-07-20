const mongodb = require('mongodb');
const randomstring = require("randomstring");
const validate = require('./validate');
const util = require('./util');
const dbUtil = require('./db-util');
const fail = require('./fail');
const config = require('./config');

const DB_NAME = 'freedb';
const ID_LENGTH = 8;
const STAGING_KEY = 'staging';

class Database {
  constructor(opts={}) {
    if (typeof opts == 'string') {
      opts = {mongodb: opts};
    }
    this.options = opts;
  }

  async initialize() {
    if (this.client) return fail("Database already initialized");
    if (this.options.host) dbUtil.setRefHost(this.options.host);
    this.client = await mongodb.MongoClient.connect(this.options.mongodb, {useNewUrlParser: true});
    this.db = this.client.db(DB_NAME);
    let coreObjects = JSON.parse(JSON.stringify(dbUtil.CORE_OBJECTS));
    for (let obj of coreObjects) {
      let coll = this.db.collection(obj.namespace + '-' + obj.schema);
      let existing = await coll.find({id: obj.document.id}).toArray();
      if (!existing[0]) {
        let encoded = util.encodeDocument(obj.document);
        await coll.insert(encoded);
      }
    }
    let db = await this.user(dbUtil.USER_KEYS.system);
    let coreTypes = JSON.parse(JSON.stringify(dbUtil.CORE_TYPES));
    for (let type of coreTypes) {
      let existing = await db.get('core', 'schema', type.id);
      if (!existing) {
        existing = await db.create('core', 'schema', type.schema, type.id);
      }
    }
  }

  async user(user) {
    if (!this.db) return fail("Database not initialized");
    const db = new DatabaseForUser({db: this.db, user});
    await db.initialize();
    return db;
  }

  async createUser(email, password) {
    if (!this.db) return fail("Database not initialized");
    let err = validate.validators.email(email) || validate.validators.password(password);
    if (err) return fail(err, 400);
    const db = await this.user(dbUtil.USER_KEYS.system);
    const existing = await db.getCollection('core', 'user_private').find({'data.email': email}).toArray();
    if (existing.length) return fail("A user with that email address already exists");
    const user = await db.create('core', 'user', {publicKey: ''});
    const creds = await util.computeCredentials(password);
    creds.email = email;
    creds.id = user.id;
    const userPrivate = await db.create('core', 'user_private', creds);
    return user;
  }

  async addToken(email, token) {
    // TODO: remove old tokens
    if (!this.db) return fail("Database not initialized");
    let err = validate.validators.email(email);
    if (err) return fail(err, 400);
    const db = await this.user(dbUtil.USER_KEYS.system);
    const existing = await db.getCollection('core', 'user_private').find({'data.email': email}).toArray();
    if (existing.length !== 1) return fail(`User ${email} not found`, 401);
    await db.append('core', 'user_private', existing[0].id, {tokens: [token]});
  }

  async signIn(email, password) {
    if (!this.db) return fail("Database not initialized");
    let err = validate.validators.email(email) || validate.validators.password(password);
    if (err) return fail(err, 400);
    const db = await this.user(dbUtil.USER_KEYS.system);
    const existing = await db.getCollection('core', 'user_private').find({'data.email': email}).toArray();
    if (!existing.length) return fail(`User ${email} not found`, 401);
    const user = existing[0].data;
    const isValid = await util.checkPassword(password, user.hash, user.salt);
    if (!isValid) return fail(`Invalid password for ${email}`);
    return user;
  }

  async signInWithToken(token) {
    const db = await this.user(dbUtil.USER_KEYS.system);
    const col = db.getCollection('core', 'user_private');
    const user = await col.find({'data.tokens': {$in: [token]}}).toArray();
    if (user.length !== 1) return fail(`The provided token is invalid`);
    return user[0].data;
  }
}

class DatabaseForUser {
  constructor(opts) {
    this.db = opts.db;
    this.userID = opts.user;
  }

  async initialize() {
    await this.refreshUser();
  }

  async refreshUser() {
    let users = await this.getCollection('core', 'user').find({id: this.userID}).toArray();
    if (!users || !users[0]) return fail(`User ${this.userID} not found`);
    if (users.length > 1) return fail("Multiple users found for ID " + this.userID);
    this.user = users[0];
  }

  getCollection(namespace, schema) {
    const collectionName = namespace + '-' + schema;
    return this.db.collection(collectionName);
  }

  async validate(obj, schema=null) {
    if (schema) {
      let err = validate.validators.data(obj.data, schema);
      if (err) return fail(err);
    }
    if (obj.acl) {
      let err = validate.validators.acl(obj.acl);
      if (err) return fail(err);
    }
    if (obj.info) {
      let err = validate.validators.info(obj.info);
      if (err) return fail(err);
    }
  }

  async getSchema(namespace, schema) {
    const namespaceInfo = await this.get('core', 'namespace', namespace);
    if (!namespaceInfo) return fail(`Namespace ${namespace} not found`);
    const nsVersion = namespaceInfo.data.versions[namespaceInfo.data.versions.length - 1];
    if (!nsVersion) return fail(`Namespace ${namespace}@${namespaceInfo.data.versions.length - 1} not found`);
    const schemaRef = (nsVersion.types[schema] || {schema: {$ref: ''}}).schema.$ref.split('/').pop();
    if (!schemaRef) return fail(`Schema ${namespace}/${schema} not found`);
    const schemaInfo = await this.get('core', 'schema', schemaRef);
    if (!schemaInfo) return fail(`Item core/schema/${schemaRef} not found`);
    return {schemaInfo, namespaceInfo: nsVersion};
  }

  buildQuery(query={}, accesses='read', modifyACL=false) {
    let accessType = modifyACL ? 'modify' : 'allowed';
    query.$and = query.$and || [];
    if (typeof accesses === 'string') accesses = [accesses];
    accesses.forEach(access => {
      let allowKey = ['acl', accessType, access].join('.');
      let disallowKey = ['acl', 'disallowed', access].join('.');
      const ownerQuery = {$and: [{'acl.owner': this.user.id}, {}, {}]};
      ownerQuery.$and[1][allowKey] = {$in: [dbUtil.USER_KEYS.owner]};
      ownerQuery.$and[2][disallowKey] = {$nin: [dbUtil.USER_KEYS.owner]};
      const accessQuery = {$and: [{}, {}]};
      accessQuery.$and[0][allowKey] = {$in: [this.user.id, dbUtil.USER_KEYS.all]};
      accessQuery.$and[1][disallowKey] = {$nin: [this.user.id, dbUtil.USER_KEYS.all]};
      query.$and.push({$or: [ownerQuery, accessQuery]});
    });
    return query;
  }

  async getAll(namespace, schema, query={}, access='read') {
    const col = this.getCollection(namespace, schema);
    query = this.buildQuery(query, access);
    let arr = await col.find(query).toArray();
    let decoded = util.decodeDocument(arr);
    return util.decodeDocument(JSON.parse(JSON.stringify(arr)));
  }

  async get(namespace, schema, id, access='read') {
    const arr = await this.getAll(namespace, schema, {id}, access);
    if (arr.length > 1) return fail(`Multiple items found for ${namespace}/${schema}/${id}`);
    if (!arr.length) return;
    return arr[0];
  }

  async create(namespace, schema, data, id='') {
    if (this.user.data.items >= config.maxItemsPerUser) {
      return fail(`You have hit your maximum of ${config.maxItemsPerUser} items. Please destroy something to create a new one`, 403);
    }
    const {schemaInfo, namespaceInfo} = await this.getSchema(namespace, schema);
    id = id || randomstring.generate(ID_LENGTH); // TODO: make sure random ID is not taken
    let err = validate.validators.itemID(id);
    if (err) return fail(err);
    const existing = await this.get(namespace, schema, id);
    if (existing) return fail(`Item ${namespace}/${schema}/${id} already exists`);
    const acl = JSON.parse(JSON.stringify(Object.assign({}, namespaceInfo.types[schema].initial_acl || dbUtil.DEFAULT_ACL)));
    acl.owner = this.user.id;
    if (namespace === 'core') {
      if (schema === 'schema') {
        util.fixSchemaRefs(data, id);
      } else if (schema === 'user') {
        acl.owner = id;
      }
    }

    const time = (new Date()).toISOString();
    const info = {
      created: time,
      updated: time,
      created_by: this.user.id,
    }

    const obj = {id, data, info, acl};
    await this.validate(obj, schemaInfo.data);
    const col = this.getCollection(namespace, schema);
    const result = await col.insert(util.encodeDocument([obj]));

    const userUpdate = {
      $inc: {'data.items': 1},
      $addToSet: {'data.namespaces': namespace},
    }
    const userCol = this.getCollection('core', 'user');
    await userCol.update({id: this.user.id}, userUpdate);
    await this.refreshUser();

    return obj;
  }

  async update(namespace, schema, id, data) {
    const query = this.buildQuery({id}, 'write');
    const {schemaInfo, namespaceInfo} = await this.getSchema(namespace, schema);
    await this.validate({data}, schemaInfo.data);
    const col = this.getCollection(namespace, schema);
    const result = await col.update(query, {
      $set: {
        data: util.encodeDocument(data),
        'info.updated': (new Date()).toISOString(),
      },
    });
    if (result.result.nModified === 0) return fail(`User ${this.userID} cannot update ${namespace}/${schema}/${id}, or ${namespace}/${schema}/${id} does not exist`, 401);
    if (result.result.nModified > 1) return fail(`Multiple items found for ${namespace}/${schema}/${id}`);
  }

  async append(namespace, schema, id, data) {
    const query = this.buildQuery({id}, 'append');
    const {schemaInfo, namespaceInfo} = await this.getSchema(namespace, schema);
    const doc = {$push: {}}
    for (let key in data) {
      let schema = schemaInfo.data.properties && schemaInfo.data.properties[key];
      if (!schema) return fail(`Schema not found for key ${key}`, 400);
      await this.validate({data: data[key]}, schemaInfo.data.properties[key]);
      doc.$push['data.' + key] = {$each: data[key]};
    }
    const col = this.getCollection(namespace, schema);
    const result = await col.update(query, doc);
    if (result.result.nModified === 0) return fail(`User ${this.userID} cannot update ${namespace}/${schema}/${id}, or ${namespace}/${schema}/${id} does not exist`, 401);
    if (result.result.nModified > 1) return fail(`Multiple items found for ${namespace}/${schema}/${id}`);
  }

  async setACL(namespace, schema, id, acl) {
    await this.validate({acl: Object.assign({owner: 'dummy'}, acl)});
    const {schemaInfo, namespaceInfo} = await this.getSchema(namespace, schema);
    const necessaryPermissions = [];
    let query = {$and: [{id}]};
    const update = {$set: {}};
    for (let key in acl) {
      if (key === 'owner') {
        query.$and.push({'acl.owner': this.user.id});
        update.$set['acl.owner'] = acl.owner;
      } else {
        for (let permission in acl[key]) {
          necessaryPermissions.push(permission);
          update.$set['acl.' + key + '.' + permission] = acl[key][permission];
        }
      }
    }
    query = this.buildQuery(query, necessaryPermissions, true);
    const col = this.getCollection(namespace, schema);
    const result = await col.update(query, update);
    if (result.result.nModified === 0) return fail(`User ${this.userID} cannot update ACL for ${namespace}/${schema}/${id}, or ${namespace}/${schema}/${id} does not exist`, 401);
    if (result.result.nModified > 1) return fail(`Multiple items found for ${namespace}/${schema}/${id}`);
  }

  async destroy(namespace, schema, id) {
    let query = {id};
    query = this.buildQuery(query, 'destroy');
    const col = this.getCollection(namespace, schema);
    const result = await col.remove(query, {justOne: true});
    if (result.result.n === 0) return fail(`User ${this.userID} cannot destroy ${namespace}/${schema}/${id}, or ${namespace}/${schema}/${id} does not exist`, 401);
    const userUpdate = {
      $inc: {'data.items': -1}
    };
    const userCol = this.getCollection('core', 'user');
    await userCol.update({id: this.user.id}, userUpdate);
    await this.refreshUser();
  }
}

module.exports = Database;
