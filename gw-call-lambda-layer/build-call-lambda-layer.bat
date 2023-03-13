SET AWS_PROFILE=goodwine

@call rmdir .\layer /s /q
@call rmdir .\node_modules /s /q
@call npm install @aws-sdk/client-cognito-identity-provider
@call npm install @aws-sdk/client-lambda
@call npm install amqplib

@call mkdir .\layer\nodejs
@call move  .\node_modules .\layer\nodejs

sam deploy --guided