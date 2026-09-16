import { Collection, Db, MongoClient } from 'mongodb';
import pino from 'pino';
import { ISubscriberRepository } from '../../domain/interfaces/subscriber-repository';
import { Subscriber, SubscriberListItem } from '../../domain/entities/subscriber';
import { MongoUriResolver } from './mongo-uri-resolver';

export class MongoSubscriberRepository implements ISubscriberRepository {
  private collection?: Collection;
  private client?: MongoClient;
  private db?: Db;

  constructor(
    private readonly uriResolver: MongoUriResolver,
    private readonly logger: pino.Logger,
  ) {}

  /**
   * Opens the connection. A failure here is logged and swallowed rather than
   * thrown, so the backend still starts when the lab is down: the UI stays
   * reachable, the lab can be started from it, and the next subscriber request
   * resolves the address again.
   */
  async connect(): Promise<void> {
    try {
      await this.openConnection();
    } catch (err) {
      this.logger.error(
        { err: String(err), target: this.uriResolver.describe() },
        'MongoDB not reachable at startup, will retry on first use',
      );
    }
  }

  async disconnect(): Promise<void> {
    await this.client?.close();
    this.client = undefined;
    this.db = undefined;
    this.collection = undefined;
  }

  private async openConnection(): Promise<void> {
    const uri = await this.uriResolver.resolve();
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
    await client.connect();

    this.client = client;
    this.db = client.db(this.uriResolver.databaseName());
    this.collection = this.db.collection('subscribers');
    this.logger.info({ database: this.uriResolver.databaseName() }, 'Connected to MongoDB');
  }

  /**
   * Every read and write goes through here, so a subscriber request either
   * reaches the database the core reads or fails saying why. It never lands on
   * a stale address, which is what a cached client would do after the lab was
   * torn down and its Service given a new ClusterIP.
   */
  private async coll(): Promise<Collection> {
    if (this.collection) {
      return this.collection;
    }
    await this.disconnect();
    await this.openConnection();
    return this.collection!;
  }

  async findAll(skip: number = 0, limit: number = 50): Promise<SubscriberListItem[]> {
    const docs = await (await this.coll())
      .find({})
      .project({ imsi: 1, msisdn: 1, slice: 1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    return docs.map((doc) => ({
      imsi: doc.imsi as string,
      msisdn: doc.msisdn as string[] | undefined,
      slice_count: Array.isArray(doc.slice) ? doc.slice.length : 0,
      session_count: Array.isArray(doc.slice)
        ? doc.slice.reduce(
            (sum: number, s: { session?: unknown[] }) =>
              sum + (Array.isArray(s.session) ? s.session.length : 0),
            0,
          )
        : 0,
    }));
  }

  async findByImsi(imsi: string): Promise<Subscriber | null> {
    const doc = await (await this.coll()).findOne({ imsi });
    if (!doc) return null;
    return doc as unknown as Subscriber;
  }

  async create(subscriber: Subscriber): Promise<void> {
    const { _id, ...data } = subscriber;
    await (await this.coll()).insertOne(data);
  }

  async update(imsi: string, subscriber: Partial<Subscriber>): Promise<void> {
    const { _id, ...data } = subscriber;
    await (await this.coll()).updateOne({ imsi }, { $set: data });
  }

  async delete(imsi: string): Promise<void> {
    await (await this.coll()).deleteOne({ imsi });
  }

  async count(): Promise<number> {
    return (await this.coll()).countDocuments();
  }

  async countSearch(query: string): Promise<number> {
    return (await this.coll()).countDocuments(this.searchFilter(query));
  }

  //One definition of what a search matches, used by both the page and its count
  private searchFilter(query: string) {
    return {
      $or: [
        { imsi: { $regex: query, $options: 'i' } },
        { msisdn: { $regex: query, $options: 'i' } },
      ],
    };
  }

  async search(query: string, skip: number = 0, limit: number = 50): Promise<SubscriberListItem[]> {
    const docs = await (await this.coll())
      .find(this.searchFilter(query))
      .project({ imsi: 1, msisdn: 1, slice: 1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    return docs.map((doc) => ({
      imsi: doc.imsi as string,
      msisdn: doc.msisdn as string[] | undefined,
      slice_count: Array.isArray(doc.slice) ? doc.slice.length : 0,
      session_count: Array.isArray(doc.slice)
        ? doc.slice.reduce(
            (sum: number, s: { session?: unknown[] }) =>
              sum + (Array.isArray(s.session) ? s.session.length : 0),
            0,
          )
        : 0,
    }));
  }

  async updateSDForAll(sd: string, sst?: number): Promise<number> {
    // Build the filter - optionally match SST
    const filter = sst ? { 'slice.sst': sst } : {};

    // Update all matching slice entries
    // If SST is specified, only update slices with that SST
    // Otherwise, update all slices
    const result = await (await this.coll()).updateMany(
      filter,
      {
        $set: {
          'slice.$[elem].sd': sd,
        },
      },
      {
        arrayFilters: sst ? [{ 'elem.sst': sst }] : [{}],
      },
    );

    this.logger.info(
      { matched: result.matchedCount, modified: result.modifiedCount, sd, sst },
      'Updated SD for subscribers',
    );

    return result.modifiedCount;
  }

  async findAllFull(): Promise<Subscriber[]> {
    const docs = await (await this.coll()).find({}).toArray();
    return docs as unknown as Subscriber[];
  }

  async assignIPv4(imsi: string, ipv4: string): Promise<void> {
    // Assign IPv4 to the first session of the first slice
    await (await this.coll()).updateOne(
      { imsi },
      {
        $set: {
          'slice.0.session.0.ue.ipv4': ipv4,
        },
      },
    );
    this.logger.info({ imsi, ipv4 }, 'Assigned IPv4 to subscriber');
  }
}
