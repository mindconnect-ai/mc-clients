package ai.mindconnect.agent.servercontrol;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.function.Consumer;
import java.util.function.IntConsumer;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Which server builds exist, and how to get one onto disk. Two sources feed
 * the catalog: the releases on Maven Central, and the rolling {@code snapshot}
 * pre-release on GitHub — the development build, always the newest state of
 * main.
 *
 * <p>Preferred delivery either way is the Spring Boot executable jar
 * (classifier {@code exec}). Releases published before that jar existed have
 * none; for those the fallback resolves the runtime classpath with a local
 * Maven installation into {@code lib-<version>/}, the same trick the shell
 * scripts use.
 */
public final class ServerReleases {

    public static final String GROUP_PATH = "ai/mindconnect";
    public static final String APP = "mc-agent-admin-ui-app";
    public static final String MAIN_CLASS = "ai.mindconnect.adminui.AdminUiApplication";

    private static final String CENTRAL = "https://repo1.maven.org/maven2/" + GROUP_PATH + "/" + APP;

    /**
     * The rolling pre-release. Its assets carry the development version in
     * their name, so the file on disk says which build it is — and the version
     * to ask for stands in {@code snapshot.txt}, a plain file rather than the
     * GitHub API, which keeps this module free of JSON parsing and out of the
     * API's rate limit.
     */
    private static final String SNAPSHOT =
            "https://github.com/mindconnect-ai/mindconnect/releases/download/snapshot";

    private static final Pattern VERSION_TAG = Pattern.compile("<version>([^<]+)</version>");
    private static final Pattern FIELD = Pattern.compile("(?m)^(\\w+):\\s*(.+)$");

    /** Where a build comes from. */
    public enum Source { CENTRAL, SNAPSHOT }

    /**
     * One installable server build.
     *
     * @param version     the Maven version — also the name of the local jar
     * @param source      which of the two channels it came from
     * @param downloadUrl the executable jar, or null when only Maven resolution reaches it
     * @param detail      what to show beside the state — commit and build time for a snapshot
     */
    public record ServerRelease(String version, Source source, String downloadUrl, String detail) {}

    private final ServerHome home;
    private final HttpClient http = HttpClient.newBuilder()
            .followRedirects(HttpClient.Redirect.NORMAL)
            .build();

    public ServerReleases(ServerHome home) {
        this.home = home;
    }

    /**
     * Everything installable: the snapshot first, then the releases newest
     * first. An unreachable snapshot channel is left out rather than failing
     * the catalog — Central alone is still a usable list.
     */
    public List<ServerRelease> catalog() throws IOException, InterruptedException {
        List<ServerRelease> catalog = new ArrayList<>();
        snapshot().ifPresent(catalog::add);
        for (String version : centralVersions()) {
            catalog.add(new ServerRelease(version, Source.CENTRAL,
                    CENTRAL + "/" + version + "/" + APP + "-" + version + "-exec.jar", null));
        }
        return catalog;
    }

    /** All released versions on Central, newest first. */
    public List<String> centralVersions() throws IOException, InterruptedException {
        HttpResponse<String> response = http.send(
                HttpRequest.newBuilder(URI.create(CENTRAL + "/maven-metadata.xml")).build(),
                HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() != 200) {
            throw new IOException("Maven Central answered " + response.statusCode());
        }
        List<String> versions = new ArrayList<>();
        Matcher m = VERSION_TAG.matcher(response.body());
        while (m.find()) versions.add(m.group(1));
        java.util.Collections.reverse(versions);
        return versions;
    }

    /**
     * The current development build, read off the snapshot channel's
     * {@code snapshot.txt} (version, commit, branch, build time). Empty when
     * the channel is unreachable or was never filled — that is a normal state,
     * not an error, so it is not thrown.
     */
    public Optional<ServerRelease> snapshot() {
        try {
            HttpResponse<String> response = http.send(
                    HttpRequest.newBuilder(URI.create(SNAPSHOT + "/snapshot.txt")).build(),
                    HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() != 200) return Optional.empty();

            String version = null;
            String commit = null;
            String built = null;
            Matcher m = FIELD.matcher(response.body());
            while (m.find()) {
                switch (m.group(1)) {
                    case "version" -> version = m.group(2).trim();
                    case "commit" -> commit = m.group(2).trim();
                    case "built" -> built = m.group(2).trim();
                    default -> { }
                }
            }
            if (version == null || version.isBlank()) return Optional.empty();

            String detail = commit == null ? built
                    : built == null ? commit : commit + " · " + built;
            return Optional.of(new ServerRelease(version, Source.SNAPSHOT,
                    SNAPSHOT + "/" + APP + "-" + version + "-exec.jar", detail));
        } catch (IOException offline) {
            return Optional.empty();
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            return Optional.empty();
        }
    }

    public Path execJar(String version) {
        return home.dir().resolve(APP + "-" + version + "-exec.jar");
    }

    public Path libDir(String version) {
        return home.dir().resolve("lib-" + version);
    }

    /** True when this version can be started without touching the network. */
    public boolean isInstalled(String version) {
        return Files.exists(execJar(version)) || Files.isDirectory(libDir(version));
    }

    /**
     * Downloads the executable jar of one build; reports progress in percent.
     * Returns false when there is none to be had — a Central release from
     * before the {@code exec} classifier existed; the caller then decides
     * about the Maven fallback.
     *
     * <p>An already-present file of the same name is overwritten on purpose: a
     * snapshot keeps its version while the build behind it moves on, so
     * "download" has to mean "fetch again".
     */
    public boolean downloadExecJar(ServerRelease release, IntConsumer percent)
            throws IOException, InterruptedException {
        if (release.downloadUrl() == null) return false;
        URI uri = URI.create(release.downloadUrl());
        HttpResponse<InputStream> response = http.send(
                HttpRequest.newBuilder(uri).build(), HttpResponse.BodyHandlers.ofInputStream());
        if (response.statusCode() == 404) return false;
        if (response.statusCode() != 200) {
            throw new IOException(uri + " answered " + response.statusCode());
        }
        long total = response.headers().firstValueAsLong("content-length").orElse(-1);
        Path target = execJar(release.version());
        Path part = target.resolveSibling(target.getFileName() + ".part");
        try (InputStream in = response.body(); OutputStream out = Files.newOutputStream(part)) {
            byte[] buffer = new byte[64 * 1024];
            long done = 0;
            int read;
            while ((read = in.read(buffer)) > 0) {
                out.write(buffer, 0, read);
                done += read;
                if (total > 0) percent.accept((int) (done * 100 / total));
            }
        }
        Files.move(part, target, StandardCopyOption.REPLACE_EXISTING);
        percent.accept(100);
        return true;
    }

    /**
     * Fallback: resolve the runtime classpath with a local {@code mvn} into
     * {@code lib-<version>/}. Maven's own output is streamed to {@code output}
     * so the UI can show what is happening.
     */
    public void resolveWithMaven(String version, Consumer<String> output)
            throws IOException, InterruptedException {
        Path mvn = findMaven();
        if (mvn == null) {
            throw new IOException("No executable jar for this version and no local Maven found — "
                    + "install Maven (brew install maven / winget install Apache.Maven) and retry.");
        }
        Path pom = home.dir().resolve("resolve-pom.xml");
        Files.writeString(pom, """
                <project xmlns="http://maven.apache.org/POM/4.0.0">
                  <modelVersion>4.0.0</modelVersion>
                  <groupId>local</groupId><artifactId>resolve</artifactId><version>1</version>
                  <packaging>pom</packaging>
                  <dependencies>
                    <dependency>
                      <groupId>ai.mindconnect</groupId>
                      <artifactId>%s</artifactId>
                      <version>%s</version>
                    </dependency>
                  </dependencies>
                </project>
                """.formatted(APP, version));
        Files.createDirectories(libDir(version));
        Process process = new ProcessBuilder(mvn.toString(), "-B", "-f", pom.toString(),
                "dependency:copy-dependencies",
                "-DincludeScope=runtime",
                "-DoutputDirectory=" + libDir(version))
                .redirectErrorStream(true)
                .start();
        try (var reader = process.inputReader()) {
            reader.lines().forEach(output);
        }
        if (process.waitFor() != 0) {
            throw new IOException("Maven dependency resolution failed — see the log above.");
        }
    }

    private static Path findMaven() {
        String pathVar = System.getenv("PATH");
        if (pathVar == null) return null;
        boolean windows = System.getProperty("os.name", "").toLowerCase().contains("win");
        for (String entry : pathVar.split(java.io.File.pathSeparator)) {
            Path candidate = Path.of(entry).resolve(windows ? "mvn.cmd" : "mvn");
            if (Files.isExecutable(candidate)) return candidate;
        }
        return null;
    }
}
