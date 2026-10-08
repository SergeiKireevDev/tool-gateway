# Example service box: a static HTTP server on port 8080.
# Like the agent image (deploy/guest-image), a service is specced as a Dockerfile: its CMD or
# ENTRYPOINT, ENV, WORKDIR and USER are what the box runs, and EXPOSE lists its ports.
#   deploy/build-service-image.sh hello-http
FROM python:3.12-slim
WORKDIR /srv
RUN echo 'Hello from a service box' > index.html
USER nobody
EXPOSE 8080
CMD ["python3", "-m", "http.server", "8080", "--bind", "0.0.0.0"]
