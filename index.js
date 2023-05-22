/**
 * <div style={{display: "flex", justifyContent: "space-between", alignItems: "center", padding: 16}}>
 *  <p style={{fontWeight: "normal"}}>Official <a href="https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Introduction.html">DynamoDB</a> adapter for Auth.js / NextAuth.js.</p>
 *  <a href="https://docs.aws.amazon.com/dynamodb/index.html">
 *   <img style={{display: "block"}} src="https://authjs.dev/img/adapters/dynamodb.png" width="48"/>
 *  </a>
 * </div>
 *
 * ## Installation
 *
 * ```bash npm2yarn2pnpm
 * npm install next-auth @next-auth/dynamodb-adapter
 * ```
 *
 * @module @next-auth/dynamodb-adapter
 */
import { v4 as uuid } from "uuid";
export function DynamoDBAdapter(client, options) {
    const TableName = options?.tableName ?? "next-auth";
    const pk = options?.partitionKey ?? "pk";
    const sk = options?.sortKey ?? "sk";
    const IndexName = options?.indexName ?? "GSI1";
    const GSI1PK = options?.indexPartitionKey ?? "GSI1PK";
    const GSI1SK = options?.indexSortKey ?? "GSI1SK";
    return {
        async createUser(data) {
            const user = {
                ...data,
                id: uuid(),
            };
            await client.put({
                TableName,
                Item: format.to({
                    ...user,
                    [pk]: `USER#${user.id}`,
                    [sk]: `USER#${user.id}`,
                    type: "USER",
                    [GSI1PK]: `USER#${user.email}`,
                    [GSI1SK]: `USER#${user.email}`,
                }),
            });
            return user;
        },
        async getUser(userId) {
            const data = await client.get({
                TableName,
                Key: {
                    [pk]: `USER#${userId}`,
                    [sk]: `USER#${userId}`,
                },
            });
            return format.from(data.Item);
        },
        async getUserByEmail(email) {
            const data = await client.query({
                TableName,
                IndexName,
                KeyConditionExpression: "#gsi1pk = :gsi1pk AND #gsi1sk = :gsi1sk",
                ExpressionAttributeNames: {
                    "#gsi1pk": GSI1PK,
                    "#gsi1sk": GSI1SK,
                },
                ExpressionAttributeValues: {
                    ":gsi1pk": `USER#${email}`,
                    ":gsi1sk": `USER#${email}`,
                },
            });
            return format.from(data.Items?.[0]);
        },
        async getUserByAccount({ provider, providerAccountId }) {
            const data = await client.query({
                TableName,
                IndexName,
                KeyConditionExpression: "#gsi1pk = :gsi1pk AND #gsi1sk = :gsi1sk",
                ExpressionAttributeNames: {
                    "#gsi1pk": GSI1PK,
                    "#gsi1sk": GSI1SK,
                },
                ExpressionAttributeValues: {
                    ":gsi1pk": `ACCOUNT#${provider}`,
                    ":gsi1sk": `ACCOUNT#${providerAccountId}`,
                },
            });
            if (!data.Items?.length)
                return null;
            const accounts = data.Items[0];
            const res = await client.get({
                TableName,
                Key: {
                    [pk]: `USER#${accounts.userId}`,
                    [sk]: `USER#${accounts.userId}`,
                },
            });
            return format.from(res.Item);
        },
        async getAccountByProviderAndUserId({ provider, userId }) {
            const data = await client.query({
                TableName,
                IndexName,
                KeyConditionExpression: "#gsi1pk = :gsi1pk",
                FilterExpression: `#filterAttribute = :filterValue`,
                ExpressionAttributeNames: {
                    "#gsi1pk": GSI1PK,
                    "#filterAttribute": 'userId',
                },
                ExpressionAttributeValues: {
                    ":gsi1pk": `ACCOUNT#${provider}`,
                    ":filterValue": `${userId}`,
                },
            });
            if (!data.Items?.length)
                return null;
            const account = data.Items[0];
            return format.from(account);
        },
        async updateUser(user) {
            const { UpdateExpression, ExpressionAttributeNames, ExpressionAttributeValues, } = generateUpdateExpression(user);
            const data = await client.update({
                TableName,
                Key: {
                    // next-auth type is incorrect it should be Partial<AdapterUser> & {id: string} instead of just Partial<AdapterUser>
                    [pk]: `USER#${user.id}`,
                    [sk]: `USER#${user.id}`,
                },
                UpdateExpression,
                ExpressionAttributeNames,
                ExpressionAttributeValues,
                ReturnValues: "ALL_NEW",
            });
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            return format.from(data.Attributes);
        },
        async deleteUser(userId) {
            // query all the items related to the user to delete
            const res = await client.query({
                TableName,
                KeyConditionExpression: "#pk = :pk",
                ExpressionAttributeNames: { "#pk": pk },
                ExpressionAttributeValues: { ":pk": `USER#${userId}` },
            });
            if (!res.Items)
                return null;
            const items = res.Items;
            // find the user we want to delete to return at the end of the function call
            const user = items.find((item) => item.type === "USER");
            const itemsToDelete = items.map((item) => {
                return {
                    DeleteRequest: {
                        Key: {
                            [sk]: item.sk,
                            [pk]: item.pk,
                        },
                    },
                };
            });
            // batch write commands cannot handle more than 25 requests at once
            const itemsToDeleteMax = itemsToDelete.slice(0, 25);
            const param = {
                RequestItems: { [TableName]: itemsToDeleteMax },
            };
            await client.batchWrite(param);
            return format.from(user);
        },
        async linkAccount(data) {
            const item = {
                ...data,
                id: uuid(),
                [pk]: `USER#${data.userId}`,
                [sk]: `ACCOUNT#${data.provider}#${data.providerAccountId}`,
                [GSI1PK]: `ACCOUNT#${data.provider}`,
                [GSI1SK]: `ACCOUNT#${data.providerAccountId}`,
            };
            await client.put({ TableName, Item: format.to(item) });
            return data;
        },
        async unlinkAccount({ provider, providerAccountId }) {
            const data = await client.query({
                TableName,
                IndexName,
                KeyConditionExpression: "#gsi1pk = :gsi1pk AND #gsi1sk = :gsi1sk",
                ExpressionAttributeNames: {
                    "#gsi1pk": GSI1PK,
                    "#gsi1sk": GSI1SK,
                },
                ExpressionAttributeValues: {
                    ":gsi1pk": `ACCOUNT#${provider}`,
                    ":gsi1sk": `ACCOUNT#${providerAccountId}`,
                },
            });
            const account = format.from(data.Items?.[0]);
            if (!account)
                return;
            await client.delete({
                TableName,
                Key: {
                    [pk]: `USER#${account.userId}`,
                    [sk]: `ACCOUNT#${provider}#${providerAccountId}`,
                },
                ReturnValues: "ALL_OLD",
            });
            return account;
        },
        async getSessionAndUser(sessionToken) {
            const data = await client.query({
                TableName,
                IndexName,
                KeyConditionExpression: "#gsi1pk = :gsi1pk AND #gsi1sk = :gsi1sk",
                ExpressionAttributeNames: {
                    "#gsi1pk": GSI1PK,
                    "#gsi1sk": GSI1SK,
                },
                ExpressionAttributeValues: {
                    ":gsi1pk": `SESSION#${sessionToken}`,
                    ":gsi1sk": `SESSION#${sessionToken}`,
                },
            });
            const session = format.from(data.Items?.[0]);
            if (!session)
                return null;
            const res = await client.get({
                TableName,
                Key: {
                    [pk]: `USER#${session.userId}`,
                    [sk]: `USER#${session.userId}`,
                },
            });
            const user = format.from(res.Item);
            if (!user)
                return null;
            return { user, session };
        },
        async createSession(data) {
            const session = {
                id: uuid(),
                ...data,
            };
            await client.put({
                TableName,
                Item: format.to({
                    [pk]: `USER#${data.userId}`,
                    [sk]: `SESSION#${data.sessionToken}`,
                    [GSI1SK]: `SESSION#${data.sessionToken}`,
                    [GSI1PK]: `SESSION#${data.sessionToken}`,
                    type: "SESSION",
                    ...data,
                }),
            });
            return session;
        },
        async updateSession(session) {
            const { sessionToken } = session;
            const data = await client.query({
                TableName,
                IndexName,
                KeyConditionExpression: "#gsi1pk = :gsi1pk AND #gsi1sk = :gsi1sk",
                ExpressionAttributeNames: {
                    "#gsi1pk": GSI1PK,
                    "#gsi1sk": GSI1SK,
                },
                ExpressionAttributeValues: {
                    ":gsi1pk": `SESSION#${sessionToken}`,
                    ":gsi1sk": `SESSION#${sessionToken}`,
                },
            });
            if (!data.Items?.length)
                return null;
            const { pk, sk } = data.Items[0];
            const { UpdateExpression, ExpressionAttributeNames, ExpressionAttributeValues, } = generateUpdateExpression(session);
            const res = await client.update({
                TableName,
                Key: { pk, sk },
                UpdateExpression,
                ExpressionAttributeNames,
                ExpressionAttributeValues,
                ReturnValues: "ALL_NEW",
            });
            return format.from(res.Attributes);
        },
        async deleteSession(sessionToken) {
            const data = await client.query({
                TableName,
                IndexName,
                KeyConditionExpression: "#gsi1pk = :gsi1pk AND #gsi1sk = :gsi1sk",
                ExpressionAttributeNames: {
                    "#gsi1pk": GSI1PK,
                    "#gsi1sk": GSI1SK,
                },
                ExpressionAttributeValues: {
                    ":gsi1pk": `SESSION#${sessionToken}`,
                    ":gsi1sk": `SESSION#${sessionToken}`,
                },
            });
            if (!data?.Items?.length)
                return null;
            const { pk, sk } = data.Items[0];
            const res = await client.delete({
                TableName,
                Key: { pk, sk },
                ReturnValues: "ALL_OLD",
            });
            return format.from(res.Attributes);
        },
        async createVerificationToken(data) {
            await client.put({
                TableName,
                Item: format.to({
                    [pk]: `VT#${data.identifier}`,
                    [sk]: `VT#${data.token}`,
                    type: "VT",
                    ...data,
                }),
            });
            return data;
        },
        async useVerificationToken({ identifier, token }) {
            const data = await client.delete({
                TableName,
                Key: {
                    [pk]: `VT#${identifier}`,
                    [sk]: `VT#${token}`,
                },
                ReturnValues: "ALL_OLD",
            });
            return format.from(data.Attributes);
        },
    };
}
// https://github.com/honeinc/is-iso-date/blob/master/index.js
const isoDateRE = /(\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d:[0-5]\d\.\d+([+-][0-2]\d:[0-5]\d|Z))|(\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d:[0-5]\d([+-][0-2]\d:[0-5]\d|Z))|(\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d([+-][0-2]\d:[0-5]\d|Z))/;
function isDate(value) {
    return value && isoDateRE.test(value) && !isNaN(Date.parse(value));
}
const format = {
    /** Takes a plain old JavaScript object and turns it into a Dynamodb object */
    to(object) {
        const newObject = {};
        for (const key in object) {
            const value = object[key];
            if (value instanceof Date) {
                // DynamoDB requires the TTL attribute be a UNIX timestamp (in secs).
                if (key === "expires")
                    newObject[key] = value.getTime() / 1000;
                else
                    newObject[key] = value.toISOString();
            }
            else
                newObject[key] = value;
        }
        return newObject;
    },
    /** Takes a Dynamo object and returns a plain old JavaScript object */
    from(object) {
        if (!object)
            return null;
        const newObject = {};
        for (const key in object) {
            // Filter DynamoDB specific attributes so it doesn't get passed to core,
            // to avoid revealing the type of database
            if (["pk", "sk", "GSI1PK", "GSI1SK"].includes(key))
                continue;
            const value = object[key];
            if (isDate(value))
                newObject[key] = new Date(value);
            // hack to keep type property in account
            else if (key === "type" && ["SESSION", "VT", "USER"].includes(value))
                continue;
            // The expires property is stored as a UNIX timestamp in seconds, but
            // JavaScript needs it in milliseconds, so multiply by 1000.
            else if (key === "expires" && typeof value === "number")
                newObject[key] = new Date(value * 1000);
            else
                newObject[key] = value;
        }
        return newObject;
    },
};
function generateUpdateExpression(object) {
    const formattedSession = format.to(object);
    let UpdateExpression = "set";
    const ExpressionAttributeNames = {};
    const ExpressionAttributeValues = {};
    for (const property in formattedSession) {
        UpdateExpression += ` #${property} = :${property},`;
        ExpressionAttributeNames["#" + property] = property;
        ExpressionAttributeValues[":" + property] = formattedSession[property];
    }
    UpdateExpression = UpdateExpression.slice(0, -1);
    return {
        UpdateExpression,
        ExpressionAttributeNames,
        ExpressionAttributeValues,
    };
}
export { format, generateUpdateExpression };
