package io.terbium.milton

import com.google.cloud.Timestamp
import com.google.cloud.datastore.*
import com.google.cloud.storage.StorageOptions
import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.request.get
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.readText
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import java.net.URL
import java.time.Instant
import java.time.temporal.ChronoUnit
import java.util.*


class PageManager(
        private val processorClient: ProcessorClient,
        private val algoliaClient: AlgoliaClient,
        projectName: String
) {
    private val pageKind = "page"
    private val bucketName = "milton-page-content"
    private val bucketPrefix = "pages"

    private val httpClient = HttpClient(OkHttp)
    private val firebase = DatastoreOptions.getDefaultInstance().toBuilder()
            .setProjectId(projectName)
            .build()
            .service
    private val storage = StorageOptions.getDefaultInstance().service
    private val bucket = storage.get(bucketName)

    suspend fun register(url: URL): RegisterResult {
        val entry = get(url.toString())
        if (entry != null) {
            return RegisterResult.Success(entry)
        }

        val insertedDate = Instant.now().truncatedTo(ChronoUnit.SECONDS)

        val response = httpClient.get<HttpResponse>(url)
        if (response.status != HttpStatusCode.OK) {
            return RegisterResult.FetchError("HTTP error: ${response.status}")
        }
        else if (response.contentType()?.withoutParameters() !in arrayOf(ContentType.Text.Plain, ContentType.Text.Html)) {
            return RegisterResult.Unsupported("unsupported content-type: ${response.contentType()}")
        }
        val processedPage = processorClient.process(response.readText(Charsets.UTF_8))

        val storageId = UUID.randomUUID().toString()
        val storageKey = "$bucketPrefix/$storageId"
        bucket.create(storageKey, processedPage.content.toByteArray(Charsets.UTF_8))

        val chunkCount = algoliaClient.indexPage(
                url.toString(),
                processedPage.title,
                processedPage.siteName,
                storageId,
                processedPage.textContent
        )

        val key = firebase.newKeyFactory().setKind(pageKind).newKey()
        val pageEntity = Entity.newBuilder(key)
                .set("url", url.toString())
                .set("domain", url.host)
                .set("storageId", storageId)
                .set("title", processedPage.title)
                .set("date", Timestamp.ofTimeSecondsAndNanos(insertedDate.epochSecond, 0))
                .setNullableString("siteName", processedPage.siteName)
                .set("chunkCount", chunkCount.toLong())
                .build()
        val registeredEntry = firebase.put(pageEntity).toRegisteredEntry()

        return RegisterResult.Success(registeredEntry)
    }

    fun getContent(storageId: String): String = bucket.get(storageId).getContent().toString(Charsets.UTF_8)

    fun list(): List<RegisteredEntry> {
        val query = Query.newEntityQueryBuilder()
                .setKind(pageKind)
                .setOrderBy(StructuredQuery.OrderBy.desc("date"))
                .build()
        return firebase.run(query).iterator().asSequence().map { it.toRegisteredEntry() }.toList()
    }

    private fun get(url: String): RegisteredEntry? {
        val query = Query.newEntityQueryBuilder()
                .setKind(pageKind)
                .setFilter(StructuredQuery.PropertyFilter.eq("url", url))
                .build()
        return firebase.run(query).asSequence().firstOrNull()?.toRegisteredEntry()
    }

    companion object {
        private fun Entity.toRegisteredEntry() = RegisteredEntry(
                url = getString("url"),
                domain = getString("domain"),
                storageId = getString("storageId"),
                title = getString("title"),
                datetime = getTimestamp("date").toDate().toInstant(),
                siteName = getNullableString("siteName")
        )

        private fun<K : IncompleteKey> FullEntity.Builder<K>.setNullableString(key: String, value: String?): FullEntity.Builder<K> {
            return apply {
                when (value) {
                    null -> setNull(key)
                    else -> set(key, value)
                }
            }
        }

        private fun Entity.getNullableString(key: String): String? =
            if (isNull(key)) { null } else { getString(key) }
    }

    data class RegisteredEntry(
            val url: String,
            val domain: String,
            val storageId: String,
            val title: String,
            val datetime: Instant,
            val siteName: String?
    )

    sealed class RegisterResult {
        class Unsupported(val cause: String) : RegisterResult()
        class FetchError(val cause: String) : RegisterResult()
        class Success(val entry: RegisteredEntry) : RegisterResult()
    }
}