import {Injectable} from '@angular/core';
import {BehaviorSubject} from 'rxjs';

declare let window:any;
declare let require:any;
const Client = require('../../../../../client');
const settings = require('../../../../../.server-config.json');
const CORE_HOST = settings.host;

const STORAGE_KEY = 'freedb_auth';

@Injectable()
export class FreeDBService {
  client:any;
  user:any;

  onUser = new BehaviorSubject(null);

  constructor() {
    window.freedbService = this;
    this.client = new Client({
      hosts: {
        core: {
          location: CORE_HOST,
        }
      },
      onUser: user => this.onUser.next(user),
    });
    this.maybeRestore();
    this.onUser.subscribe(user => {
      this.user = user;
      if (!window.localStorage) return
      const toStore = {
        hosts: this.client.hosts,
      };
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(toStore))
    })
  }

  async maybeRestore() {
    if (!window.localStorage) return;
    let existing:any = window.localStorage.getItem(STORAGE_KEY);
    if (!existing) return;
    existing = JSON.parse(existing);
    if (!existing || !existing.hosts) return;
    await this.client.setHosts(existing.hosts);
  }
}