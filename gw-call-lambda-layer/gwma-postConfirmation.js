'use strict';

const REGION = process.env.GW_DYNAMODB_REGION;
const QUEUE_URL = process.env.GW_QUEUE_URL; //'https://sqs.eu-west-1.amazonaws.com/242478065669/goodwine-middleware-user-data';
const CONFIRM_SIGN_UP = 'PostConfirmation_ConfirmSignUp';
const STATUS_CONFIRMED = 'CONFIRMED';
const STATUS_UNCONFIRMED = 'UNCONFIRMED';


let AWS = require('aws-sdk');
let cognito = new AWS.CognitoIdentityServiceProvider();
let http = require("http");
let https = require("https");
let sqs = new AWS.SQS({region : REGION});


exports.handler = (event, context, callback) => {
    console.log(event);

    const {userName, triggerSource, userPoolId, request} = event;
    const {sub, email, phone_number, identities, given_name, family_name, gender} = request.userAttributes;
    const user_status = request.userAttributes['cognito:user_status'];


    if (triggerSource === CONFIRM_SIGN_UP && user_status === STATUS_CONFIRMED) {
        return getUserByAttributes(['email', 'phone_number'], request.userAttributes, userPoolId)
        .then(cognitoUser => {
            if (cognitoUser) {
                return deleteUser(cognitoUser.Username, userPoolId)
                    .then (() => linkUsers (cognitoUser, userName, sub, 'Cognito', userPoolId))
                    .then (() => userData (userName, sub, email, phone_number, identities, user_status))
                    .then (() => callback (null, event));
            } else {  // it's needed to check if a user exists is dynamoDB
                return getDynamoDBUser(['email', 'phone_number'], event.request.userAttributes)
                    .then(oldSub => {
                        if(oldSub) {
                            getUserByAttributes(['sub'], {'sub': oldSub}, userPoolId)
                                .then(cognitoDouble => {
                                    if(cognitoDouble) {
                                        return deleteUser(cognitoUser.Username, userPoolId)
                                            .then (() => linkUsers (cognitoUser, userName, sub, 'Cognito', userPoolId))
                                            .then (() => userData (userName, sub, email, phone_number, identities, user_status))
                                            .then (() => callback (null, event));
                                    } else {
                                        return merge (oldSub, cognitoUser.Attributes.find(attribute => attribute.Name === 'sub').Value)
                                            .then (() => userData(userName, sub, email, phone_number, identities, user_status))
                                            .then (() => callback(null, event));
                                    }
                                });
                        } else {
                            return userData(userName, sub, email, phone_number, identities, user_status, given_name, family_name, gender)
                                .then(() => callback(null, event));
                        }
                    });
            }
        }).catch(err => {
            console.error(err);
            callback('Something get wrong');
        });
    } else {
        const googleAccessKey = event.request.userAttributes['custom:googleAccessKey'];
        if (event.userName.includes("Google") && googleAccessKey) {
            return googleGetGender(googleAccessKey)
            .then(gender => userData(userName, sub, email, phone_number, identities, user_status, given_name, family_name, gender))
                .then(() => deleteAttributes(['custom:googleAccessKey'], event.userName, event.userPoolId))
                .then(() => callback(null, event));
        } else {
            return userData(userName, sub, email, phone_number, identities, user_status, given_name, family_name, gender)
                .then(() => callback(null, event));
        }
    }
};

let getDynamoDBUser = async (attributeNames, attributeValues) => {
    
    console.log(`Find a dynamoDB user by ${attributeNames} with ${JSON.stringify(attributeValues)}`);
    
    const { LambdaClient, InvokeCommand } = require("@aws-sdk/client-lambda");
    const funcName = "gwma-search-user";
    const client = new LambdaClient({region: REGION});

    const aliases = {'email' : 'email', 'phone_number' : 'phone'};

    let event = {
        "stage-variables": {
            "GW_MA_TOKEN_EXP_PERIOD": process.env.GW_MA_TOKEN_EXP_PERIOD,
            "GW_DYNAMODB_REGION": REGION,
            "GW_DYNAMODB_ACCESS_KEY_ID": process.env.GW_DYNAMODB_ACCESS_KEY_ID,
            "GW_DYNAMODB_SECRET_ACCESS_KEY": process.env.GW_DYNAMODB_SECRET_ACCESS_KEY,
            "GW_MA_STAGE": process.env.GW_MA_STAGE,
            "GW_MA_DETAILED_LOGGING": process.env.GW_MA_DETAILED_LOGGING
        },
        "payload": {
            "filters": {}
        }
    };

    for(const attributeName of attributeNames){
        let attributeValue = attributeValues[attributeName];
        if(!attributeValue) continue;
        event.payload.filters[aliases[attributeName]] = attributeValues[attributeName];
    }

    const command = new InvokeCommand({
        FunctionName: funcName,
        Payload: JSON.stringify(event),
        InvokationType: 'Event'
    });
    
    try {
        const { Payload } = await client.send(command);
        const result = JSON.parse(Buffer.from(Payload).toString());
        console.log(JSON.stringify(result, null, " ")); 
        return result.data.find(user => user !== undefined)?.sub;
    } catch (error) {
        console.error(JSON.stringify(error, null, " "));
        throw error;
    }
};

let getUserByAttributes = async (attributeNames, attributeValues, userPoolId, checkIfNotConfirmed = true) => {
    
    console.log(`Find a cognito user by ${attributeNames} with ${JSON.stringify(attributeValues)}`);

    for(const attributeName of attributeNames){
        let attributeValue = attributeValues[attributeName];
        if(!attributeValue) continue;
        let data = await cognito.listUsers({
            UserPoolId: userPoolId,
            Filter: `${attributeName} = "${attributeValue}"`
        }).promise();        
        console.log(JSON.stringify(data, null, " "));
        
        let user = data.Users.find(user => ( !checkIfNotConfirmed || user.UserStatus !== STATUS_CONFIRMED) );
        if (user) return user;
    }
    return undefined; // there are no nonconfirmed users
};

let linkUsers = (externalUser, internalUsername, internalSub, internalProviderName, userPoolId) => {
    console.log(`Link the cognito user ${internalUsername} with ${JSON.stringify(externalUser)}`);
    if(!externalUser || externalUser.UserStatus != STATUS_UNCONFIRMED)
        return Promise.resolve(); // There is no user to link
    
    let identities = JSON.parse(externalUser.Attributes.find(attribute => attribute.Name === 'identities').Value);
    let result = Promise.resolve();
    
    console.log('Count ' + identities.length);
    for (let i = 0; i < identities.length; i++) {
        console.log(identities[i]);
        result = result.then(() => cognito.adminLinkProviderForUser({
            UserPoolId: userPoolId,
            SourceUser: {
                ProviderName: identities[i].providerName,
                ProviderAttributeName: 'Cognito_Subject',
                ProviderAttributeValue: identities[i].userId,
            },
            DestinationUser: {
                ProviderName: internalProviderName,
                ProviderAttributeValue: internalUsername,
            }
        }).promise());
    }
    result.then(() => merge (externalUser.Attributes.find(attribute => attribute.Name === 'sub').Value, internalSub));
    return result;
};

let deleteUser = (username, userPoolId) => {
    console.log(`Delete the cognito user ${username} of pool ${userPoolId}`);
    return cognito.adminDeleteUser({
        Username: username,
        UserPoolId: userPoolId
    }).promise();
};

let  deleteAttributes = (attributes, username, userPoolId) => {
    console.log(`Delete attributes ${JSON.stringify(attributes)} of the cognito user ${username} of pool ${userPoolId}`);
    return cognito.adminDeleteUserAttributes({
        UserAttributeNames: attributes,
        Username: username,
        UserPoolId: userPoolId
    }).promise();
};

let merge = (oldSub, newSub) => {
    return new Promise((resolve, reject) => {
        console.log('merge');
        console.log('old ' + oldSub + ' new ' + newSub);
        // call external rest service over https post
        var post_data = {
    	    "oldSub": oldSub,
    	    "newSub": newSub
        };
    
        var post_options = {
            host:  process.env.GW_MERGE_SERVICE_HOST, //'gwmauserservice.eu-west-1.elasticbeanstalk.com',
            port: process.env.GW_MERGE_SERVICE_PORT, //'80',
            path: '/user/merge',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'api-key': process.env.GW_MERGE_SERVICE_KEY, //''bY9hLuw69e3qSsnkqLgeB95ZWRyT5aRvrPrzb7ZaeF3xP7e2UGYyDW4cDgrnqjZ4DequADEbLuHbaXKFFVDCutVLdFCP5ryCGRwpK7zZBH6JvcGA8qHgerhmq2LPU9xL',
                'Content-Length': Buffer.byteLength(JSON.stringify(post_data))
            }
        };
        var post_req = http.request(post_options, function(res) {
            console.log(`STATUS: ${res.statusCode}`);
            console.log(`HEADERS: ${JSON.stringify(res.headers)}`);
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                console.log(`BODY: ${chunk}`);
            });
            res.on('end', () => {
                console.log('No more data in response.');
                resolve();
            });
        });
        post_req.write(JSON.stringify(post_data));
        post_req.end();
    });
};

let userData = (username, sub, email, phoneNumber, identities, cognitoUserStatus, firstName, lastName, gender) => {
    return new Promise((resolve, reject) => {
        console.log('userData');
        // call external rest service over https post
        if (firstName === '') {
            firstName = null;
        }
        if (lastName === '') {
            lastName = null;
        }
        if (email === '') {
            email = null;
        }
        if (phoneNumber === '') {
            phoneNumber = null;
        }
        if (gender === 'male') {
            gender = 'M';
        } else if (gender == 'female') {
            gender = 'F';
        } else {
            gender = null;
        }
        
        var post_data = {
    	    "firstName": firstName,
    	    "lastName": lastName,
    	    "phone": phoneNumber,
    	    "gender": gender,
    	    "email": email,
    	    "identities": identities,
    	    "cognitoUserStatus": cognitoUserStatus,
    	    "username": username,
    	    "sub": sub
        };
        console.log(`Update gwma user ${JSON.stringify(post_data, null, 2)}`);
        var post_options = {
            host:  process.env.GW_MERGE_SERVICE_HOST, //'gwmauserservice.eu-west-1.elasticbeanstalk.com',
            port: process.env.GW_MERGE_SERVICE_PORT, //'80',
            path: '/user/data?sub=' + sub + "&username=" + username + "&isCognito=true",
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'api-key': process.env.GW_MERGE_SERVICE_KEY, //'bY9hLuw69e3qSsnkqLgeB95ZWRyT5aRvrPrzb7ZaeF3xP7e2UGYyDW4cDgrnqjZ4DequADEbLuHbaXKFFVDCutVLdFCP5ryCGRwpK7zZBH6JvcGA8qHgerhmq2LPU9xL',
                'Content-Length': Buffer.byteLength(JSON.stringify(post_data))
            }
        };
        var post_req = http.request(post_options, function(res) {
            console.log(res.statusCode);
            let params = {
                MessageBody: JSON.stringify(post_data),
                QueueUrl: QUEUE_URL
            };
            sqs.sendMessage(params, function(err,data) {
                if(err) {
                    console.log('error:',"Fail Send Message" + err);
                    resolve();
                } else {
                    console.log('data:',data.MessageId);
                    resolve();
                }
            });
            
        });
        post_req.write(JSON.stringify(post_data));
        post_req.end();
    });
};

let googleGetGender = (accessKey) => {
    return new Promise((resolve, reject) => {
        console.log('googleGetGender');
        // call external rest service over https post
        https.get('https://www.googleapis.com/oauth2/v1/userinfo?alt=json&access_token=' + accessKey, (res) => {
            console.log('statusCode:', res.statusCode);
    
            var data = '';
    
            res.on('data', function(chunk) {
                data += chunk;
            }).on('end', function() {
                //at this point data is an array of Buffers
                //so Buffer.concat() can make us a new Buffer
                //of all of them together
                let response = JSON.parse(data);
                resolve(response.gender);
            });
        });
    });
};