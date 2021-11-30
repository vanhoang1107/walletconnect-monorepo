FROM node:14

WORKDIR /opt/app/

COPY package*.json /opt/app/

RUN npm install --global npm
RUN npm install

COPY . /opt/app/

RUN npm run build

CMD ["node", "./dist/index.js" ]
