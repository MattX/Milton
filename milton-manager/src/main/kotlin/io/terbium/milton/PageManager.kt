/*
 * Copyright 2020 The Milton Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

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
import io.terbium.milton.FirebaseExtensions.getNullableString
import io.terbium.milton.FirebaseExtensions.setNullableString
import org.slf4j.LoggerFactory
import java.net.URL
import java.time.Instant
import java.time.temporal.ChronoUnit
import java.util.*
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class PageManager @Inject constructor(
        private val processorClient: ProcessorClient,
        private val algoliaClient: AlgoliaClient,
        @ProjectName projectName: String
) {
    private val httpClient = HttpClient(OkHttp)
    private val firebase = DatastoreOptions.getDefaultInstance().toBuilder()
            .setProjectId(projectName)
            .build()
            .service
    private val storage = StorageOptions.getDefaultInstance().service
    private val bucket = storage.get(BUCKET_NAME)

    suspend fun register(url: URL): RegisterResult {
        val entry = get(url.toString())?.first
        if (entry != null) {
            logger.info("not indexing $entry as it is already in the database.")
            return RegisterResult.Success(entry)
        }

        val insertedDate = Instant.now().truncatedTo(ChronoUnit.SECONDS)

        logger.info("requesting $url")
        val response = httpClient.get<HttpResponse>(url)
        if (response.status != HttpStatusCode.OK) {
            logger.warn("got status ${response.status} for $url.")
            return RegisterResult.FetchError("HTTP error: ${response.status}")
        }
        else if (response.contentType()?.withoutParameters() !in arrayOf(ContentType.Text.Plain, ContentType.Text.Html)) {
            logger.warn("unsupported content-type: ${response.contentType()} for $url")
            return RegisterResult.Unsupported("unsupported content-type: ${response.contentType()}")
        }
        logger.info("sending $url to the processor")
        val processedPage = processorClient.process(response.readText(Charsets.UTF_8))

        logger.info("saving page data for $url")
        val storageId = UUID.randomUUID().toString()
        val storageKey = "$BUCKET_PREFIX/$storageId"
        bucket.create(storageKey, processedPage.content.toByteArray(Charsets.UTF_8))

        logger.info("saving $url to Algolia")
        val chunkCount = algoliaClient.indexPage(
                url.toString(),
                processedPage.title,
                processedPage.siteName,
                storageId,
                processedPage.textContent
        )

        logger.info("saving $entry to Firebase")
        val key = firebase.newKeyFactory().setKind(PAGE_KIND).newKey()
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

    fun getContent(storageId: String): String {
        val storageKey = "$BUCKET_PREFIX/$storageId"
        return bucket.get(storageKey).getContent().toString(Charsets.UTF_8)
    }

    fun list(): List<RegisteredEntry> {
        val query = Query.newEntityQueryBuilder()
                .setKind(PAGE_KIND)
                .setOrderBy(StructuredQuery.OrderBy.desc("date"))
                .build()
        return firebase.run(query).iterator().asSequence().map { it.toRegisteredEntry() }.toList()
    }

    private fun get(url: String): Pair<RegisteredEntry, Key>? {
        val query = Query.newEntityQueryBuilder()
                .setKind(PAGE_KIND)
                .setFilter(StructuredQuery.PropertyFilter.eq("url", url))
                .build()
        val result = firebase.run(query).asSequence().firstOrNull() ?: return null
        return Pair(result.toRegisteredEntry(), result.key)
    }

    suspend fun delete(url: URL): Boolean {
        val url = url.toString()
        val (entry, key) = get(url) ?: return false
        logger.info("deleting $url from search index")
        algoliaClient.deletePage(url)
        logger.info("deleting $url from bucket")
        val storageKey = "$BUCKET_PREFIX/${entry.storageId}"
        bucket.get(storageKey).delete()
        logger.info("deleting $url from database")
        firebase.delete(key)
        return true
    }

    companion object {
        private const val PAGE_KIND = "page"
        private const val BUCKET_NAME = "milton-page-content"
        private const val BUCKET_PREFIX = "pages"

        private fun Entity.toRegisteredEntry() = RegisteredEntry(
                url = getString("url"),
                domain = getString("domain"),
                storageId = getString("storageId"),
                title = getString("title"),
                datetime = getTimestamp("date").toDate().toInstant(),
                siteName = getNullableString("siteName")
        )

        private val logger = LoggerFactory.getLogger(PageManager::class.java)
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