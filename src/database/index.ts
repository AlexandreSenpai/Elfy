import Dexie, { Table } from "dexie";

export type IHub = {
    slug: string;
    ownerId: string;
}

export type IUsers = {
    machine: string;
    id: string;
    name: string;
    avatar: string;
}

export type IHubEvent = {
    id: string;
    hubSlug: string;
    sender: string;
    type: 'broadcast_start' | 'broadcast_end' | 'joined' | 'exited'
    timestamp: number;
    content: string;
}

class Database extends Dexie {
    hubs!: Table<IHub>;
    events!: Table<IHubEvent>;
    users!: Table<IUsers>;

    constructor() {
        super('ElfyDB');
        this.version(1).stores({
            hubs: 'slug, ownerId',
            users: 'machine, id',
            events: 'id, hubSlug, timestamp, type'
        })
    }
}

export const db = new Database();